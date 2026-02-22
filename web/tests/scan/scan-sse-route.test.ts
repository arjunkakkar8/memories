import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/server/scan/pipeline', () => ({
	runScanPipeline: vi.fn()
}));

vi.mock('../../src/lib/server/auth/revocable-token-store', () => ({
	getAccessToken: vi.fn()
}));

import { runScanPipeline } from '../../src/lib/server/scan/pipeline';
import { getAccessToken } from '../../src/lib/server/auth/revocable-token-store';
import { POST as startScan } from '../../src/routes/api/scan/+server';
import type { RankedScanCandidate } from '../../src/lib/server/scan/types';

type ParsedSseEvent = {
	event: string;
	data: Record<string, unknown>;
};

function parseSseEvents(body: string): ParsedSseEvent[] {
	return body
		.split('\n\n')
		.map((frame) => frame.trim())
		.filter(Boolean)
		.map((frame) => {
			const eventLine = frame
				.split('\n')
				.find((line) => line.startsWith('event: '))
				?.replace('event: ', '');
			const dataLine = frame
				.split('\n')
				.find((line) => line.startsWith('data: '))
				?.replace('data: ', '');

			return {
				event: eventLine ?? '',
				data: JSON.parse(dataLine ?? '{}') as Record<string, unknown>
			};
		});
}

function candidate(threadId: string): RankedScanCandidate {
	return {
		threadId,
		metadata: {
			threadId,
			historyId: null,
			subject: 'Subject',
			participants: ['person@example.com'],
			messageCount: 3,
			firstMessageAt: '2026-01-01T00:00:00.000Z',
			lastMessageAt: '2026-02-01T00:00:00.000Z',
			latestSnippet: 'Latest update'
		},
		signals: {
			messageDepth: 0.7,
			participantDiversity: 0.3,
			recency: 0.8,
			continuity: 0.9,
			total: 0.68
		},
		llm: {
			threadId,
			score: 0.9,
			rationale: 'Strong narrative arc',
			themes: ['change']
		},
		combinedScore: 0.81,
		rank: 1
	};
}

describe('scan SSE route', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.mocked(getAccessToken).mockReturnValue('gmail-access-token');
	});

	it('streams scan.started -> progress/candidates -> scan.complete with SSE headers', async () => {
		const ranked = candidate('thread-1');
		vi.mocked(runScanPipeline).mockImplementation(async (options) => {
			options.onProgress?.({
				stage: 'fetch',
				processed: 5,
				total: 5,
				message: 'Fetched metadata'
			});
			options.onCandidateBatch?.({
				batchIndex: 0,
				candidates: [ranked]
			});
			options.onProgress?.({
				stage: 'llm',
				processed: 1,
				total: 1,
				message: 'Scored candidates'
			});

			return {
				rankedCandidates: [ranked],
				progress: []
			};
		});

		const response = await startScan({
			request: new Request('http://localhost:5173/api/scan', {
				method: 'POST',
				headers: {
					'content-type': 'application/json'
				},
				body: JSON.stringify({ query: 'newer_than:90d' })
			}),
			locals: {
				session: {
					id: 'session-1'
				}
			},
			fetch
		} as never);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/event-stream');
		expect(response.headers.get('cache-control')).toContain('no-cache');

		const events = parseSseEvents(await response.text());
		const eventNames = events.map((event) => event.event);
		expect(eventNames[0]).toBe('scan.started');
		expect(eventNames).toContain('scan.progress');
		expect(eventNames).toContain('scan.candidates');
		expect(eventNames[eventNames.length - 1]).toBe('scan.complete');

		const firstCandidateIndex = eventNames.indexOf('scan.candidates');
		const completeIndex = eventNames.indexOf('scan.complete');
		expect(firstCandidateIndex).toBeGreaterThan(-1);
		expect(completeIndex).toBeGreaterThan(firstCandidateIndex);
	});

	it('emits scan.error event when the pipeline fails during execution', async () => {
		vi.mocked(runScanPipeline).mockImplementation(async (options) => {
			options.onProgress?.({
				stage: 'fetch',
				processed: 1,
				total: 1,
				message: 'Fetched metadata'
			});
			throw new Error('gmail_request_failed:503');
		});

		const response = await startScan({
			request: new Request('http://localhost:5173/api/scan', { method: 'POST' }),
			locals: {
				session: {
					id: 'session-1'
				}
			},
			fetch
		} as never);

		expect(response.status).toBe(200);

		const events = parseSseEvents(await response.text());
		const errorEvent = events.find((event) => event.event === 'scan.error');
		expect(errorEvent).toBeDefined();
		expect(errorEvent?.data).toMatchObject({
			code: 'gmail_request_failed:503',
			recoverable: true
		});
	});
});
