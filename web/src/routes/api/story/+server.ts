import {
	getAccessToken,
	getRefreshToken,
	rememberAccessToken
} from '$lib/server/auth/revocable-token-store';
import { refreshGoogleAccessToken } from '$lib/server/auth/google-token-refresh';
import { runStoryPipeline } from '$lib/server/story/pipeline';
import { z } from 'zod';
import type { RequestHandler } from './$types';

const requestSchema = z.object({
	threadId: z.string().min(1)
});

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json'
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

	if (error.message.startsWith('gmail_request_failed:')) {
		return { status: 502, code: 'story_gmail_request_failed' };
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
	if (!locals.session) {
		return json({ error: { code: 'unauthorized' } }, 401);
	}

	let parsedBody: z.infer<typeof requestSchema>;
	try {
		parsedBody = requestSchema.parse(await request.json());
	} catch {
		return json({ error: { code: 'invalid_request_body' } }, 400);
	}

	const accessToken = getAccessToken(locals.session.id);
	if (!accessToken) {
		return json({ error: { code: 'gmail_access_token_missing' } }, 400);
	}

	const runPipeline = async (token: string) =>
		runStoryPipeline({
			threadId: parsedBody.threadId,
			accessToken: token,
			fetchImpl: fetch
		});

	try {
		const result = await runPipeline(accessToken);

		return json({
			story: result.story,
			metadata: result.metadata
		});
	} catch (error) {
		if (!isGmailAuthExpiredError(error)) {
			const { status, code } = mapError(error);
			return json({ error: { code } }, status);
		}

		const refreshToken = getRefreshToken(locals.session.id);
		if (!refreshToken) {
			return json({ error: { code: 'gmail_reauth_required' } }, 401);
		}

		try {
			const refreshed = await refreshGoogleAccessToken(refreshToken, { fetchImpl: fetch });
			rememberAccessToken(locals.session.id, refreshed.accessToken);

			const result = await runPipeline(refreshed.accessToken);
			return json({
				story: result.story,
				metadata: result.metadata
			});
		} catch (retryOrRefreshError) {
			if (isGmailAuthExpiredError(retryOrRefreshError)) {
				return json({ error: { code: 'gmail_reauth_required' } }, 401);
			}

			if (
				retryOrRefreshError instanceof Error &&
				(retryOrRefreshError.message === 'google_refresh_token_missing' ||
					retryOrRefreshError.message.startsWith('google_token_refresh_') ||
					retryOrRefreshError.message === 'google_oauth_not_configured')
			) {
				return json({ error: { code: 'gmail_reauth_required' } }, 401);
			}

			const { status, code } = mapError(retryOrRefreshError);
			return json({ error: { code } }, status);
		}
	}
};
