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

function jsonRequest(body: unknown, accept?: string): Request {
	return new Request('http://localhost:5173/api/story', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(accept ? { accept } : {})
		},
		body: JSON.stringify(body)
	});
}

type ParsedSseEvent = {
	event: string;
	data: unknown;
};

async function readSseEvents(response: Response): Promise<ParsedSseEvent[]> {
	const payload = await response.text();
	const chunks = payload.split('\n\n').filter(Boolean);
	const events: ParsedSseEvent[] = [];

	for (const chunk of chunks) {
		const lines = chunk.split('\n');
		let eventName = '';
		let dataText = '';

		for (const line of lines) {
			if (line.startsWith('event:')) {
				eventName = line.slice('event:'.length).trim();
			}
			if (line.startsWith('data:')) {
				dataText = line.slice('data:'.length).trim();
			}
		}

		if (!eventName || !dataText) {
			continue;
		}

		events.push({
			event: eventName,
			data: JSON.parse(dataText)
		});
	}

	return events;
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
		vi.mocked(runStoryPipeline).mockRejectedValueOnce(
			new Error('gmail_request_failed:429 provider details')
		);

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

		vi.mocked(runStoryPipeline).mockRejectedValueOnce(
			new Error('story_research_missing_selected_thread')
		);

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

	it('requires Gmail reauth when provider reports insufficient permissions', async () => {
		vi.mocked(runStoryPipeline).mockRejectedValueOnce(
			new Error('gmail_request_failed:403:threads.get:insufficientPermissions')
		);

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
	});

	it('requires Gmail reauth when token only has metadata Gmail scope', async () => {
		vi.mocked(runStoryPipeline).mockRejectedValueOnce(
			new Error('gmail_request_failed:403:threads.get:metadataScopeFullFormatForbidden')
		);

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
			scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly',
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
		expect(refreshGoogleAccessToken).toHaveBeenCalledWith('gmail-refresh-token', {
			fetchImpl: fetch
		});
		const refreshedScopes = [
			'openid',
			'email',
			'profile',
			'https://www.googleapis.com/auth/gmail.readonly'
		];
		expect(rememberAccessToken).toHaveBeenCalledWith(
			'session-1',
			'refreshed-access-token',
			refreshedScopes
		);
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
		vi.mocked(runStoryPipeline).mockRejectedValueOnce(
			new Error('gmail_request_failed:401 access token expired')
		);

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
		vi.mocked(runStoryPipeline).mockRejectedValueOnce(
			new Error('gmail_request_failed:401 access token expired')
		);
		vi.mocked(refreshGoogleAccessToken).mockRejectedValueOnce(
			new Error('google_token_refresh_failed:400')
		);

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

	it('streams ordered SSE lifecycle events when requested', async () => {
		vi.mocked(runStoryPipeline).mockImplementation(async (options) => {
			options.onProgress?.({
				stage: 'pipeline.started',
				label: 'Starting story generation',
				timestamp: '2026-02-23T00:00:00.000Z'
			});
			options.onToken?.({
				token: 'Hello',
				index: 0,
				timestamp: '2026-02-23T00:00:01.000Z'
			});
			options.onToken?.({
				token: ' world',
				index: 1,
				timestamp: '2026-02-23T00:00:01.100Z'
			});
			return {
				story: 'Hello world',
				metadata: {
					threadId: 'thread-123',
					model: 'openai/gpt-4o-mini',
					research: {
						steps: 2,
						relatedThreads: 1,
						participantHistories: 1
					}
				}
			};
		});

		const response = await createStory({
			request: jsonRequest({ threadId: 'thread-123' }, 'text/event-stream'),
			locals: {
				session: { id: 'session-1' }
			},
			fetch
		} as never);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/event-stream');
		const events = await readSseEvents(response);
		expect(events.map((event) => event.event)).toEqual([
			'story.started',
			'story.status',
			'story.token',
			'story.token',
			'story.complete'
		]);
		expect(events[4]).toEqual({
			event: 'story.complete',
			data: expect.objectContaining({
				story: 'Hello world'
			})
		});
	});

	it('streams story.error with stable code on failures', async () => {
		vi.mocked(runStoryPipeline).mockRejectedValueOnce(new Error('story_generation_empty'));

		const response = await createStory({
			request: jsonRequest({ threadId: 'thread-123' }, 'text/event-stream'),
			locals: {
				session: { id: 'session-1' }
			},
			fetch
		} as never);

		expect(response.status).toBe(200);
		const events = await readSseEvents(response);
		expect(events.map((event) => event.event)).toEqual(['story.started', 'story.error']);
		expect(events[1]).toEqual({
			event: 'story.error',
			data: {
				code: 'story_generation_failed'
			}
		});
	});
});
