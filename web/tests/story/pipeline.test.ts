import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/static/private', () => ({
	OPENROUTER_API_KEY: 'openrouter-test-key',
	OPENROUTER_MODEL: 'openai/gpt-4o-mini'
}));

vi.mock('ai', () => ({
	generateText: vi.fn(),
	streamText: vi.fn(),
	stepCountIs: vi.fn((count: number) => ({ type: 'step-count-is', count }))
}));

vi.mock('@openrouter/ai-sdk-provider', () => ({
	createOpenRouter: vi.fn(() => (model: string) => ({ model }))
}));

vi.mock('../../src/lib/server/story/gmail-research', () => ({
	createStoryResearchBudget: vi.fn(() => ({ id: 'budget' })),
	fetchSelectedThread: vi.fn(async (threadId: string) => ({
		threadId,
		historyId: null,
		subject: 'Selected thread',
		participants: ['alex@example.com', 'jamie@example.com'],
		messageCount: 2,
		firstMessageAt: '2026-01-01T00:00:00.000Z',
		lastMessageAt: '2026-01-02T00:00:00.000Z',
		latestSnippet: 'Snippet',
		messages: [],
		provenance: [{ source: 'selected_thread', query: null }]
	})),
	searchRelatedThreads: vi.fn(async () => []),
	getParticipantHistory: vi.fn(async () => []),
	searchThreadsByConcept: vi.fn(async () => []),
	searchThreadsByTimeWindow: vi.fn(async () => []),
	expandParticipantNetwork: vi.fn(async () => [])
}));

vi.mock('../../src/lib/server/story/tools', () => ({
	createStoryToolRuntime: vi.fn(),
	buildStoryResearchContext: vi.fn()
}));

import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateText, stepCountIs, streamText } from 'ai';
import { fetchSelectedThread } from '../../src/lib/server/story/gmail-research';
import {
	buildStoryResearchContext,
	createStoryToolRuntime
} from '../../src/lib/server/story/tools';
import { runStoryPipeline } from '../../src/lib/server/story/pipeline';

const toolSet = {
	getSelectedThread: { description: 'Fetch selected thread' },
	searchRelatedThreads: { description: 'Search related threads' },
	getParticipantHistory: { description: 'Fetch participant history' },
	searchThreadsByConcept: { description: 'Search concept threads' },
	searchThreadsByTimeWindow: { description: 'Search timeline threads' },
	expandParticipantNetwork: { description: 'Expand participant graph' }
};

const baseContext = {
	selectedThread: {
		threadId: 'thread-123',
		historyId: null,
		subject: 'A subject',
		participants: ['alex@example.com', 'jamie@example.com'],
		messageCount: 3,
		firstMessageAt: '2026-01-01T00:00:00.000Z',
		lastMessageAt: '2026-01-03T00:00:00.000Z',
		latestSnippet: 'Latest snippet',
		messages: [],
		provenance: [{ source: 'selected_thread', query: null }]
	},
	relatedThreads: Array.from({ length: 6 }, (_, index) => ({
		threadId: `thread-related-${index + 1}`,
		historyId: null,
		subject: `Related ${index + 1}`,
		participants: ['alex@example.com'],
		messageCount: 2,
		firstMessageAt: null,
		lastMessageAt: null,
		latestSnippet: null,
		messages: [],
		provenance: [
			{
				source: index < 3 ? 'search_threads_by_concept' : 'search_related_threads',
				query: null
			}
		]
	})),
	participantHistory: [
		{
			participant: 'alex@example.com',
			threads: []
		},
		{
			participant: 'jamie@example.com',
			threads: []
		},
		{
			participant: 'kai@example.com',
			threads: []
		}
	],
	explorationSummary: {
		relatedThreadsDiscovered: 6,
		participantHistoriesLoaded: 3,
		conceptThreadsFound: 3,
		timelineThreadsFound: 1,
		participantNetworkThreadsFound: 1,
		provenanceCounts: {
			search_related_threads: 3,
			search_threads_by_concept: 3
		}
	}
};

describe('runStoryPipeline', () => {
	beforeEach(() => {
		vi.resetAllMocks();

		vi.mocked(createStoryToolRuntime).mockReturnValue({
			tools: toolSet as never,
			state: {
				selectedThread: null,
				relatedThreads: new Map(),
				participantHistory: new Map()
			},
			ingestRelatedThreads: vi.fn(),
			mergeParticipantHistory: vi.fn()
		});

		vi.mocked(buildStoryResearchContext).mockReturnValue(baseContext as never);

		vi.mocked(generateText)
			.mockResolvedValueOnce({ steps: [{ type: 'tool-call' }, { type: 'tool-call' }] } as never)
			.mockResolvedValueOnce({ text: '  The story text.  ' } as never);
	});

	function createTextStream(tokens: string[]): AsyncIterable<string> {
		return {
			async *[Symbol.asyncIterator]() {
				for (const token of tokens) {
					yield token;
				}
			}
		};
	}

	it('runs deep-default bounded research with broadened tools before Markdown writing', async () => {
		const result = await runStoryPipeline({
			threadId: 'thread-123',
			accessToken: 'gmail-access-token',
			fetchImpl: vi.fn() as never
		});

		expect(createOpenRouter).toHaveBeenCalledWith(
			expect.objectContaining({
				apiKey: 'openrouter-test-key',
				fetch: expect.any(Function),
				extraBody: {
					provider: {
						allow_fallbacks: false,
						data_collection: 'deny',
						zdr: true
					}
				}
			})
		);

		expect(generateText).toHaveBeenCalledTimes(2);
		const researchCall = vi.mocked(generateText).mock.calls[0]?.[0];
		expect(researchCall?.tools).toMatchObject({
			getSelectedThread: expect.any(Object),
			searchRelatedThreads: expect.any(Object),
			getParticipantHistory: expect.any(Object),
			searchThreadsByConcept: expect.any(Object),
			searchThreadsByTimeWindow: expect.any(Object),
			expandParticipantNetwork: expect.any(Object)
		});
		expect(researchCall?.stopWhen).toEqual({ type: 'step-count-is', count: 20 });
		expect(researchCall?.prompt).toContain('Coverage minimums');
		expect(researchCall?.prompt).toContain('Exploration profile: deep');

		const writingCall = vi.mocked(generateText).mock.calls[1]?.[0];
		expect(writingCall?.prompt).toContain('Write a narrative driven Markdown story');
		expect(writingCall?.prompt).toContain('second-person');
		expect(stepCountIs).toHaveBeenCalledWith(20);

		expect(result).toMatchObject({
			story: 'The story text.',
			metadata: {
				threadId: 'thread-123',
				format: 'markdown',
				research: {
					steps: 2,
					relatedThreads: 6,
					participantHistories: 3
				},
				exploration: {
					profile: 'deep',
					relatedThreadsDiscovered: 6,
					conceptThreadsFound: 3
				}
			}
		});
	});

	it('backfills selected thread when research tools did not fetch it', async () => {
		await runStoryPipeline({
			threadId: 'thread-123',
			accessToken: 'gmail-access-token',
			fetchImpl: vi.fn() as never
		});

		expect(fetchSelectedThread).toHaveBeenCalledWith(
			'thread-123',
			expect.objectContaining({
				accessToken: 'gmail-access-token'
			})
		);
	});

	it('fails with stable error when narrative generation returns empty text', async () => {
		vi.mocked(generateText).mockReset();
		vi.mocked(generateText)
			.mockResolvedValueOnce({ steps: [] } as never)
			.mockResolvedValueOnce({ text: '   ' } as never);

		await expect(
			runStoryPipeline({
				threadId: 'thread-123',
				accessToken: 'gmail-access-token'
			})
		).rejects.toThrow('story_generation_empty');
	});

	it('emits stage progress updates including retry scheduling metadata', async () => {
		vi.mocked(generateText).mockReset();
		vi.mocked(generateText)
			.mockRejectedValueOnce(new Error('openrouter_request_failed:503'))
			.mockResolvedValueOnce({ steps: [{ type: 'tool-call' }] } as never)
			.mockResolvedValueOnce({ text: 'Story after retry.' } as never);

		const progress: string[] = [];
		await runStoryPipeline({
			threadId: 'thread-123',
			accessToken: 'gmail-access-token',
			onProgress: (entry) => {
				progress.push(entry.stage);
			}
		});

		expect(progress).toContain('pipeline.started');
		expect(progress).toContain('research.retry.scheduled');
		expect(progress).toContain('research.completed');
		expect(progress).toContain('writer.completed');
	});

	it('streams writer tokens in order and reconstructs final story', async () => {
		vi.mocked(generateText).mockReset();
		vi.mocked(generateText).mockResolvedValueOnce({ steps: [] } as never);
		vi.mocked(streamText).mockReturnValue({
			textStream: createTextStream(['The ', 'final ', 'story.']),
			text: Promise.resolve('The final story.')
		} as never);

		const tokens: string[] = [];
		const result = await runStoryPipeline({
			threadId: 'thread-123',
			accessToken: 'gmail-access-token',
			streamWriterTokens: true,
			onToken: (entry) => {
				tokens.push(entry.token);
			}
		});

		expect(tokens).toEqual(['The ', 'final ', 'story.', '']);
		expect(result.story).toBe('The final story.');
	});
});
