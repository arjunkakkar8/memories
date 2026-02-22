import {
	getAccessToken,
	getRefreshToken,
	rememberAccessToken
} from '$lib/server/auth/revocable-token-store';
import { hasRequiredGmailScope } from '$lib/server/auth/scope-plan';
import { refreshGoogleAccessToken } from '$lib/server/auth/google-token-refresh';
import { QuotaBudgetError } from '$lib/server/scan/quota-budget';
import { createStoryRequestLogger, describeStoryError } from '$lib/server/story/logging';
import { runStoryPipeline } from '$lib/server/story/pipeline';
import { z } from 'zod';
import type { RequestHandler } from './$types';

const requestSchema = z.object({
	threadId: z.string().min(1)
});

function json(body: unknown, status = 200, requestId: string): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json',
			'x-story-request-id': requestId
		}
	});
}

function mapError(error: unknown): { status: number; code: string } {
	if (!(error instanceof Error)) {
		return {
			status: 500,
			code: 'story_unknown_error'
		};
	}

	if (error.message === 'thread_id_required') {
		return { status: 400, code: 'thread_id_required' };
	}

	if (error.message === 'gmail_access_token_missing') {
		return { status: 400, code: 'gmail_access_token_missing' };
	}

	if (error.message === 'openrouter_api_key_missing') {
		return { status: 503, code: 'story_model_unavailable' };
	}

	if (error.message.startsWith('openrouter_request_failed:')) {
		return { status: 503, code: 'story_model_unavailable' };
	}

	if (error.message.startsWith('gmail_request_failed:')) {
		if (
			error.message.includes(':metadataScopeFullFormatForbidden') ||
			error.message.includes(':insufficientPermissions') ||
			error.message.includes(':authError') ||
			error.message.includes(':invalidCredentials')
		) {
			return { status: 401, code: 'gmail_reauth_required' };
		}

		return { status: 502, code: 'story_gmail_request_failed' };
	}

	if (error instanceof QuotaBudgetError) {
		return { status: 429, code: 'story_generation_failed' };
	}

	if (error.message === 'story_research_missing_selected_thread' || error.message === 'story_generation_empty') {
		return { status: 502, code: 'story_generation_failed' };
	}

	return { status: 500, code: 'story_generation_failed' };
}

function isGmailAuthExpiredError(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith('gmail_request_failed:401');
}

export const POST: RequestHandler = async ({ request, locals, fetch }) => {
	const logger = createStoryRequestLogger({
		sessionId: locals.session?.id ?? null
	});
	const grantedScopes = Array.isArray(locals.session?.grantedScopes)
		? locals.session.grantedScopes
		: null;

	logger.info('story.request.received', {
		hasSession: Boolean(locals.session),
		hasGrantedScopes: Boolean(grantedScopes),
		hasReadonlyScope: hasRequiredGmailScope(grantedScopes)
	});

	if (!locals.session) {
		logger.warn('story.request.rejected.unauthorized');
		return json({ error: { code: 'unauthorized' } }, 401, logger.requestId);
	}

	let parsedBody: z.infer<typeof requestSchema>;
	try {
		parsedBody = requestSchema.parse(await request.json());
	} catch {
		logger.warn('story.request.rejected.invalid_body');
		return json({ error: { code: 'invalid_request_body' } }, 400, logger.requestId);
	}

	const requestLogger = logger.withContext({ threadId: parsedBody.threadId });
	requestLogger.info('story.request.parsed');

	if (grantedScopes && !hasRequiredGmailScope(grantedScopes)) {
		requestLogger.warn('story.request.rejected.missing_required_scope', {
			grantedScopes
		});
		return json({ error: { code: 'gmail_reauth_required' } }, 401, requestLogger.requestId);
	}

	const accessToken = getAccessToken(locals.session.id);
	if (!accessToken) {
		requestLogger.warn('story.request.rejected.access_token_missing');
		return json({ error: { code: 'gmail_access_token_missing' } }, 400, requestLogger.requestId);
	}

	const runPipeline = async (token: string, attempt: 'initial' | 'after_refresh') => {
		const startedAt = Date.now();
		requestLogger.info('story.pipeline.attempt.started', {
			attempt
		});

		try {
			const result = await runStoryPipeline({
				threadId: parsedBody.threadId,
				accessToken: token,
				fetchImpl: fetch,
				logger: requestLogger
			});

			requestLogger.info('story.pipeline.attempt.completed', {
				attempt,
				durationMs: Date.now() - startedAt,
				research: result.metadata.research
			});

			return result;
		} catch (error) {
			requestLogger.warn('story.pipeline.attempt.failed', {
				attempt,
				durationMs: Date.now() - startedAt,
				...describeStoryError(error)
			});
			throw error;
		}
	};

	try {
		const result = await runPipeline(accessToken, 'initial');

		return json({
			story: result.story,
			metadata: result.metadata
		}, 200, requestLogger.requestId);
	} catch (error) {
		if (!isGmailAuthExpiredError(error)) {
			const { status, code } = mapError(error);
			requestLogger.trackError('story.request.failed', error, {
				status,
				code
			});
			return json({ error: { code } }, status, requestLogger.requestId);
		}

		requestLogger.warn('story.request.refresh_attempt.started');
		const refreshToken = getRefreshToken(locals.session.id);
		if (!refreshToken) {
			requestLogger.warn('story.request.refresh_attempt.missing_refresh_token');
			return json({ error: { code: 'gmail_reauth_required' } }, 401, requestLogger.requestId);
		}

		try {
			const refreshed = await refreshGoogleAccessToken(refreshToken, { fetchImpl: fetch });
			const refreshedScopes = (refreshed.scope ?? '').split(' ').filter(Boolean);
			if (!hasRequiredGmailScope(refreshedScopes)) {
				requestLogger.warn('story.request.refresh_attempt.missing_required_scope', {
					refreshedScopes,
					scopeFieldPresent: Boolean(refreshed.scope)
				});
				return json({ error: { code: 'gmail_reauth_required' } }, 401, requestLogger.requestId);
			}

			rememberAccessToken(locals.session.id, refreshed.accessToken, refreshedScopes);
			requestLogger.info('story.request.refresh_attempt.succeeded', {
				refreshedScopes,
				expiresIn: refreshed.expiresIn
			});

			const result = await runPipeline(refreshed.accessToken, 'after_refresh');
			return json({
				story: result.story,
				metadata: result.metadata
			}, 200, requestLogger.requestId);
		} catch (retryOrRefreshError) {
			if (isGmailAuthExpiredError(retryOrRefreshError)) {
				requestLogger.warn('story.request.refresh_attempt.failed_reauth_required', {
					...describeStoryError(retryOrRefreshError)
				});
				return json({ error: { code: 'gmail_reauth_required' } }, 401, requestLogger.requestId);
			}

			if (
				retryOrRefreshError instanceof Error &&
				(retryOrRefreshError.message === 'google_refresh_token_missing' ||
					retryOrRefreshError.message.startsWith('google_token_refresh_') ||
					retryOrRefreshError.message === 'google_oauth_not_configured')
			) {
				requestLogger.warn('story.request.refresh_attempt.failed_refresh_exchange', {
					...describeStoryError(retryOrRefreshError)
				});
				return json({ error: { code: 'gmail_reauth_required' } }, 401, requestLogger.requestId);
			}

			const { status, code } = mapError(retryOrRefreshError);
			requestLogger.trackError('story.request.failed_after_refresh', retryOrRefreshError, {
				status,
				code
			});
			return json({ error: { code } }, status, requestLogger.requestId);
		}
	}
};
