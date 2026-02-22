import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/server/story/pipeline', () => ({
	runStoryPipeline: vi.fn()
}));

vi.mock('../../src/lib/server/auth/revocable-token-store', () => ({
	getAccessToken: vi.fn(),
	getRefreshToken: vi.fn(),
	rememberAccessToken: vi.fn()
}));

vi.mock('../../src/lib/server/auth/google-token-refresh', () => ({
	refreshGoogleAccessToken: vi.fn()
}));

import {
	getAccessToken,
	getRefreshToken,
	rememberAccessToken
} from '../../src/lib/server/auth/revocable-token-store';
import { refreshGoogleAccessToken } from '../../src/lib/server/auth/google-token-refresh';
import { runStoryPipeline } from '../../src/lib/server/story/pipeline';
import { POST as createStory } from '../../src/routes/api/story/+server';

function jsonRequest(body: unknown): Request {
	return new Request('http://localhost:5173/api/story', {
		method: 'POST',
		headers: {
			'content-type': 'application/json'
		},
		body: JSON.stringify(body)
	});
}

	describe('/api/story POST route', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getAccessToken).mockReturnValue('gmail-access-token');
		vi.mocked(getRefreshToken).mockReturnValue('gmail-refresh-token');
	});

	it('returns unauthorized when no authenticated session exists', async () => {
		const response = await createStory({
			request: jsonRequest({ threadId: 'thread-123' }),
			locals: {
				session: null
			},
			fetch
		} as never);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			error: { code: 'unauthorized' }
		});
		expect(runStoryPipeline).not.toHaveBeenCalled();
	});

	it('returns missing-token error when server session has no Gmail token', async () => {
		vi.mocked(getAccessToken).mockReturnValue(null);

		const response = await createStory({
			request: jsonRequest({ threadId: 'thread-123' }),
			locals: {
				session: { id: 'session-1' }
			},
			fetch
		} as never);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: { code: 'gmail_access_token_missing' }
		});
		expect(runStoryPipeline).not.toHaveBeenCalled();
	});

	it('returns invalid request body for missing or malformed threadId', async () => {
		const response = await createStory({
			request: jsonRequest({ threadId: '' }),
			locals: {
				session: { id: 'session-1' }
			},
			fetch
		} as never);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: { code: 'invalid_request_body' }
		});
		expect(runStoryPipeline).not.toHaveBeenCalled();
	});

	it('returns stable story envelope for successful generation', async () => {
		vi.mocked(runStoryPipeline).mockResolvedValue({
			story: 'A third-person narrative story.',
			metadata: {
				threadId: 'thread-123',
				model: 'openai/gpt-4o-mini',
				research: {
					steps: 3,
					relatedThreads: 2,
					participantHistories: 1
				}
			}
		} as never);

		const response = await createStory({
			request: jsonRequest({ threadId: 'thread-123' }),
			locals: {
				session: { id: 'session-1' }
			},
			fetch
		} as never);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			story: 'A third-person narrative story.',
			metadata: {
				threadId: 'thread-123',
				model: 'openai/gpt-4o-mini',
				research: {
					steps: 3,
					relatedThreads: 2,
					participantHistories: 1
				}
			}
		});

		expect(runStoryPipeline).toHaveBeenCalledWith(
			expect.objectContaining({
				threadId: 'thread-123',
				accessToken: 'gmail-access-token'
			})
		);
	});

	it('maps provider/tool failures to non-sensitive stable error envelopes', async () => {
		vi.mocked(runStoryPipeline).mockRejectedValueOnce(new Error('gmail_request_failed:429 provider details'));

		const providerFailure = await createStory({
			request: jsonRequest({ threadId: 'thread-123' }),
			locals: {
				session: { id: 'session-1' }
			},
			fetch
		} as never);

		expect(providerFailure.status).toBe(502);
		expect(await providerFailure.json()).toEqual({
			error: { code: 'story_gmail_request_failed' }
		});

		vi.mocked(runStoryPipeline).mockRejectedValueOnce(new Error('story_research_missing_selected_thread'));

		const toolFailure = await createStory({
			request: jsonRequest({ threadId: 'thread-123' }),
			locals: {
				session: { id: 'session-1' }
			},
			fetch
		} as never);

		expect(toolFailure.status).toBe(502);
		expect(await toolFailure.json()).toEqual({
			error: { code: 'story_generation_failed' }
		});
	});

	it('refreshes expired Gmail auth and retries story generation once', async () => {
		vi.mocked(runStoryPipeline)
			.mockRejectedValueOnce(new Error('gmail_request_failed:401 access token expired'))
			.mockResolvedValueOnce({
				story: 'Recovered story output',
				metadata: {
					threadId: 'thread-123',
					model: 'openai/gpt-4o-mini',
					research: {
						steps: 1,
						relatedThreads: 0,
						participantHistories: 0
					}
				}
			} as never);

		vi.mocked(refreshGoogleAccessToken).mockResolvedValue({
			accessToken: 'refreshed-access-token',
			expiresIn: 3600,
			scope: null,
			tokenType: 'Bearer'
		});

		const response = await createStory({
			request: jsonRequest({ threadId: 'thread-123' }),
			locals: {
				session: { id: 'session-1' }
			},
			fetch
		} as never);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			story: 'Recovered story output'
		});
		expect(refreshGoogleAccessToken).toHaveBeenCalledWith('gmail-refresh-token', { fetchImpl: fetch });
		expect(rememberAccessToken).toHaveBeenCalledWith('session-1', 'refreshed-access-token');
		expect(runStoryPipeline).toHaveBeenCalledTimes(2);
		expect(runStoryPipeline).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				accessToken: 'refreshed-access-token'
			})
		);
	});

	it('returns explicit auth recovery error when refresh token is unavailable', async () => {
		vi.mocked(getRefreshToken).mockReturnValue(null);
		vi.mocked(runStoryPipeline).mockRejectedValueOnce(new Error('gmail_request_failed:401 access token expired'));

		const response = await createStory({
			request: jsonRequest({ threadId: 'thread-123' }),
			locals: {
				session: { id: 'session-1' }
			},
			fetch
		} as never);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			error: { code: 'gmail_reauth_required' }
		});
		expect(refreshGoogleAccessToken).not.toHaveBeenCalled();
		expect(runStoryPipeline).toHaveBeenCalledTimes(1);
	});

	it('returns explicit auth recovery error when refresh exchange fails', async () => {
		vi.mocked(runStoryPipeline).mockRejectedValueOnce(new Error('gmail_request_failed:401 access token expired'));
		vi.mocked(refreshGoogleAccessToken).mockRejectedValueOnce(new Error('google_token_refresh_failed:400'));

		const response = await createStory({
			request: jsonRequest({ threadId: 'thread-123' }),
			locals: {
				session: { id: 'session-1' }
			},
			fetch
		} as never);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			error: { code: 'gmail_reauth_required' }
		});
		expect(runStoryPipeline).toHaveBeenCalledTimes(1);
	});
});
