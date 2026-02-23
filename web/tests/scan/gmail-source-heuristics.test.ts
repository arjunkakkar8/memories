import { describe, expect, it, vi } from 'vitest';
import { fetchGmailThreadMetadata } from '../../src/lib/server/scan/gmail-source';
import { filterCandidates } from '../../src/lib/server/scan/heuristics';
import { createQuotaBudget } from '../../src/lib/server/scan/quota-budget';
import type { ScanThreadMetadata } from '../../src/lib/server/scan/types';

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: {
			'content-type': 'application/json'
		}
	});
}

describe('fetchGmailThreadMetadata', () => {
	it('paginates Gmail threads and enriches metadata in bounded batches', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(typeof input === 'string' ? input : input.toString());

			if (url.pathname.endsWith('/threads') && !url.searchParams.get('pageToken')) {
				return jsonResponse({
					nextPageToken: 'page-2',
					threads: [{ id: 'thread-1' }, { id: 'thread-2' }]
				});
			}

			if (url.pathname.endsWith('/threads') && url.searchParams.get('pageToken') === 'page-2') {
				return jsonResponse({
					threads: [{ id: 'thread-3' }]
				});
			}

			const threadId = url.pathname.split('/').pop();
			return jsonResponse({
				id: threadId,
				historyId: `${threadId}-history`,
				snippet: `Latest update for ${threadId}`,
				messages: [
					{
						internalDate: String(new Date('2025-01-01T00:00:00Z').getTime()),
						payload: {
							headers: [
								{ name: 'Subject', value: `Subject ${threadId}` },
								{ name: 'From', value: 'alex@example.com' },
								{ name: 'To', value: 'jamie@example.com' }
							]
						}
					},
					{
						internalDate: String(new Date('2025-02-01T00:00:00Z').getTime()),
						payload: {
							headers: [{ name: 'From', value: 'jamie@example.com' }]
						}
					}
				]
			});
		});

		const metadata = await fetchGmailThreadMetadata({
			accessToken: 'token-123',
			budget: createQuotaBudget({ maxGmailUnits: 200, maxConcurrentGmail: 3 }),
			fetchImpl: fetchMock as typeof fetch,
			pageSize: 2,
			maxPages: 2,
			threadDetailsConcurrency: 2
		});

		expect(metadata).toHaveLength(3);
		expect(metadata.map((item) => item.threadId)).toEqual(['thread-1', 'thread-2', 'thread-3']);
		expect(metadata[0]).toMatchObject({
			subject: 'Subject thread-1',
			messageCount: 2,
			participantsNormalized: ['alex@example.com', 'jamie@example.com'],
			senderDomains: ['example.com']
		});
	});

	it('retries on recoverable quota/rate responses', async () => {
		let listAttempts = 0;

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(typeof input === 'string' ? input : input.toString());
			if (url.pathname.endsWith('/threads')) {
				listAttempts += 1;
				if (listAttempts === 1) {
					return jsonResponse({ error: 'rate_limited' }, 429);
				}

				return jsonResponse({ threads: [{ id: 'thread-1' }] });
			}

			return jsonResponse({
				id: 'thread-1',
				messages: []
			});
		});

		const metadata = await fetchGmailThreadMetadata({
			accessToken: 'token-123',
			budget: createQuotaBudget({ maxGmailUnits: 200 }),
			fetchImpl: fetchMock as typeof fetch,
			maxPages: 1
		});

		expect(metadata).toHaveLength(1);
		expect(listAttempts).toBe(2);
	});

	it('returns partial metadata when quota budget is exhausted', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(typeof input === 'string' ? input : input.toString());

			if (url.pathname.endsWith('/threads')) {
				return jsonResponse({
					threads: [{ id: 'thread-1' }, { id: 'thread-2' }, { id: 'thread-3' }]
				});
			}

			const threadId = url.pathname.split('/').pop();
			return jsonResponse({
				id: threadId,
				messages: []
			});
		});

		const metadata = await fetchGmailThreadMetadata({
			accessToken: 'token-123',
			budget: createQuotaBudget({ maxGmailUnits: 30 }),
			fetchImpl: fetchMock as typeof fetch,
			maxPages: 1,
			threadDetailsConcurrency: 3
		});

		expect(metadata.map((entry) => entry.threadId)).toEqual(['thread-1', 'thread-2']);
	});
});

describe('filterCandidates', () => {
	it('filters low-signal threads before LLM scoring', () => {
		const now = new Date('2026-01-01T00:00:00Z');

		const candidates: ScanThreadMetadata[] = [
			{
				threadId: 'weak-thread',
				historyId: null,
				subject: 'One message ping',
				subjectLexical: 'one message ping',
				snippetLexical: '',
				participants: ['solo@example.com'],
				participantsNormalized: ['solo@example.com'],
				senderAddresses: ['solo@example.com'],
				senderDomains: ['example.com'],
				labelIds: [],
				importanceMarkers: {
					important: false,
					starred: false,
					hasUserLabels: false
				},
				messageCount: 1,
				firstMessageAt: '2023-01-01T00:00:00Z',
				lastMessageAt: '2023-01-01T00:00:00Z',
				latestSnippet: null,
				retrieval: {
					hitCount: 1,
					packIds: ['inbox-focus'],
					windowIds: ['window-1'],
					hits: []
				}
			},
			{
				threadId: 'strong-thread',
				historyId: null,
				subject: 'Big life update',
				subjectLexical: 'big life update',
				snippetLexical: 'thank you for being there',
				participants: ['alex@example.com', 'jamie@example.com', 'mom@example.com'],
				participantsNormalized: ['alex@example.com', 'jamie@example.com', 'mom@example.com'],
				senderAddresses: ['alex@example.com'],
				senderDomains: ['example.com'],
				labelIds: ['IMPORTANT'],
				importanceMarkers: {
					important: true,
					starred: false,
					hasUserLabels: false
				},
				messageCount: 14,
				firstMessageAt: '2025-10-01T00:00:00Z',
				lastMessageAt: '2025-12-25T00:00:00Z',
				latestSnippet: 'Thank you for being there',
				retrieval: {
					hitCount: 3,
					packIds: ['inbox-focus', 'starred-important'],
					windowIds: ['window-1', 'window-2'],
					hits: []
				}
			}
		];

		const result = filterCandidates(candidates, {
			now,
			minTotalScore: 0.35,
			minMessageCount: 2
		});

		expect(result.kept).toHaveLength(1);
		expect(result.kept[0]?.metadata.threadId).toBe('strong-thread');
		expect(result.kept[0]?.signals.provenanceStrength).toBeGreaterThan(0);
		expect(result.kept[0]?.signals.actionabilityLexical).toBeGreaterThan(0);
		expect(result.kept[0]?.signals.historicalPersistence).toBeGreaterThan(0);
		expect('recency' in (result.kept[0]?.signals ?? {})).toBe(false);
		expect(result.dropped).toHaveLength(1);
		expect(result.dropped[0]?.metadata.threadId).toBe('weak-thread');
	});
});
