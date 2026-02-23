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
import { toSseEvent, type StorySseEvent } from './events';
import { createStoryStreamState } from './stream-state';
import { z } from 'zod';
import type { RequestHandler } from './$types';

const requestSchema = z.object({
	threadId: z.string().min(1)
});

const HEARTBEAT_INTERVAL_MS = 15_000;

function json(body: unknown, status = 200, requestId: string): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json',
			'x-story-request-id': requestId
		}
	});
}

function sseHeaders(requestId: string): Record<string, string> {
	return {
		'content-type': 'text/event-stream; charset=utf-8',
		'cache-control': 'no-cache, no-transform',
		connection: 'keep-alive',
		'x-accel-buffering': 'no',
		'x-story-request-id': requestId
	};
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

	if (
		error.message === 'story_research_missing_selected_thread' ||
		error.message === 'story_generation_empty'
	) {
		return { status: 502, code: 'story_generation_failed' };
	}

	return { status: 500, code: 'story_generation_failed' };
}

function isGmailAuthExpiredError(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith('gmail_request_failed:401');
}

function wantsEventStream(request: Request): boolean {
	const accept = request.headers.get('accept') ?? '';
	return accept.includes('text/event-stream');
}

async function executeStoryRequest(options: {
	threadId: string;
	sessionId: string;
	accessToken: string;
	fetchImpl: typeof fetch;
	logger: ReturnType<typeof createStoryRequestLogger>;
	streamWriterTokens: boolean;
	onProgress?: Parameters<typeof runStoryPipeline>[0]['onProgress'];
	onToken?: Parameters<typeof runStoryPipeline>[0]['onToken'];
}): Promise<Awaited<ReturnType<typeof runStoryPipeline>>> {
	const {
		threadId,
		sessionId,
		accessToken,
		fetchImpl,
		logger,
		streamWriterTokens,
		onProgress,
		onToken
	} = options;

	const runPipeline = async (token: string, attempt: 'initial' | 'after_refresh') => {
		const startedAt = Date.now();
		logger.info('story.pipeline.attempt.started', {
			attempt,
			streamWriterTokens
		});

		try {
			const result = await runStoryPipeline({
				threadId,
				accessToken: token,
				fetchImpl,
				logger,
				streamWriterTokens,
				onProgress,
				onToken
			});

			logger.info('story.pipeline.attempt.completed', {
				attempt,
				durationMs: Date.now() - startedAt,
				research: result.metadata.research
			});

			return result;
		} catch (error) {
			logger.warn('story.pipeline.attempt.failed', {
				attempt,
				durationMs: Date.now() - startedAt,
				...describeStoryError(error)
			});
			throw error;
		}
	};

	try {
		return await runPipeline(accessToken, 'initial');
	} catch (error) {
		if (!isGmailAuthExpiredError(error)) {
			throw error;
		}

		logger.warn('story.request.refresh_attempt.started');
		const refreshToken = getRefreshToken(sessionId);
		if (!refreshToken) {
			logger.warn('story.request.refresh_attempt.missing_refresh_token');
			throw new Error('gmail_request_failed:401 refresh_token_missing');
		}

		const refreshed = await refreshGoogleAccessToken(refreshToken, { fetchImpl });
		const refreshedScopes = (refreshed.scope ?? '').split(' ').filter(Boolean);
		if (!hasRequiredGmailScope(refreshedScopes)) {
			logger.warn('story.request.refresh_attempt.missing_required_scope', {
				refreshedScopes,
				scopeFieldPresent: Boolean(refreshed.scope)
			});
			throw new Error('gmail_request_failed:401 insufficient_scope_after_refresh');
		}

		rememberAccessToken(sessionId, refreshed.accessToken, refreshedScopes);
		logger.info('story.request.refresh_attempt.succeeded', {
			refreshedScopes,
			expiresIn: refreshed.expiresIn
		});

		return runPipeline(refreshed.accessToken, 'after_refresh');
	}
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

	const sessionId = locals.session.id;

	if (!wantsEventStream(request)) {
		try {
			const result = await executeStoryRequest({
				threadId: parsedBody.threadId,
				sessionId,
				accessToken,
				fetchImpl: fetch,
				logger: requestLogger,
				streamWriterTokens: false
			});

			return json(
				{
					story: result.story,
					metadata: result.metadata
				},
				200,
				requestLogger.requestId
			);
		} catch (error) {
			if (
				error instanceof Error &&
				(error.message === 'google_refresh_token_missing' ||
					error.message.startsWith('google_token_refresh_') ||
					error.message === 'google_oauth_not_configured' ||
					isGmailAuthExpiredError(error))
			) {
				requestLogger.warn('story.request.failed_reauth_required', {
					...describeStoryError(error)
				});
				return json({ error: { code: 'gmail_reauth_required' } }, 401, requestLogger.requestId);
			}

			const { status, code } = mapError(error);
			requestLogger.trackError('story.request.failed', error, {
				status,
				code
			});
			return json({ error: { code } }, status, requestLogger.requestId);
		}
	}

	const streamState = createStoryStreamState();
	const encoder = new TextEncoder();

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let isClosed = false;
			const streamStartedAt = Date.now();

			const enqueue = (event: StorySseEvent): void => {
				if (isClosed) {
					return;
				}

				if (event.event === 'story.status') {
					streamState.incrementStatusCount();
				}

				if (event.event === 'story.token') {
					streamState.incrementTokenCount();
				}

				controller.enqueue(encoder.encode(toSseEvent(event, streamState.nextEventId())));
			};

			const close = (): void => {
				if (isClosed) {
					return;
				}

				isClosed = true;
				controller.close();
			};

			const heartbeat = setInterval(() => {
				enqueue({
					event: 'story.keepalive',
					data: {
						timestamp: new Date().toISOString()
					}
				});
			}, HEARTBEAT_INTERVAL_MS);

			requestLogger.info('story.stream.started');
			enqueue({
				event: 'story.started',
				data: {
					startedAt: new Date().toISOString()
				}
			});

			void executeStoryRequest({
				threadId: parsedBody.threadId,
				sessionId,
				accessToken,
				fetchImpl: fetch,
				logger: requestLogger,
				streamWriterTokens: true,
				onProgress: (progress) => {
					enqueue({
						event: 'story.status',
						data: progress
					});
				},
				onToken: (token) => {
					enqueue({
						event: 'story.token',
						data: token
					});
				}
			})
				.then((result) => {
					enqueue({
						event: 'story.complete',
						data: {
							completedAt: new Date().toISOString(),
							story: result.story,
							metadata: result.metadata
						}
					});
					const stats = streamState.snapshot();
					requestLogger.info('story.stream.completed', {
						durationMs: Date.now() - streamStartedAt,
						statusEventCount: stats.statusEventCount,
						tokenEventCount: stats.tokenEventCount
					});
				})
				.catch((error: unknown) => {
					const code =
						error instanceof Error &&
						(error.message === 'google_refresh_token_missing' ||
							error.message.startsWith('google_token_refresh_') ||
							error.message === 'google_oauth_not_configured' ||
							isGmailAuthExpiredError(error))
							? 'gmail_reauth_required'
							: mapError(error).code;

					enqueue({
						event: 'story.error',
						data: {
							code
						}
					});

					const stats = streamState.snapshot();
					requestLogger.trackError('story.stream.failed', error, {
						code,
						durationMs: Date.now() - streamStartedAt,
						statusEventCount: stats.statusEventCount,
						tokenEventCount: stats.tokenEventCount
					});
				})
				.finally(() => {
					clearInterval(heartbeat);
					close();
				});
		},
		cancel() {
			// Request scope is ephemeral; pipeline run naturally completes.
		}
	});

	return new Response(stream, {
		status: 200,
		headers: sseHeaders(requestLogger.requestId)
	});
};
