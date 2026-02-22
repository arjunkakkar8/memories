import { describe, expect, it, vi } from 'vitest';
import { runScanPipeline } from '../../src/lib/server/scan/pipeline';
import { createQuotaBudget } from '../../src/lib/server/scan/quota-budget';

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: {
			'content-type': 'application/json'
		}
	});
}

describe('runScanPipeline', () => {
	it('runs fetch -> heuristics -> llm stages and returns ranked results', async () => {
		const gmailFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(typeof input === 'string' ? input : input.toString());

			if (url.pathname.endsWith('/threads')) {
				return jsonResponse({
					threads: [{ id: 'thread-1' }, { id: 'thread-2' }]
				});
			}

			const threadId = url.pathname.split('/').pop();
			if (threadId === 'thread-1') {
				return jsonResponse({
					id: 'thread-1',
					snippet: 'A major life chapter is unfolding',
					messages: [
						{
							internalDate: String(new Date('2025-10-01T00:00:00Z').getTime()),
							payload: {
								headers: [
									{ name: 'Subject', value: 'Moving abroad' },
									{ name: 'From', value: 'alex@example.com' },
									{ name: 'To', value: 'jamie@example.com' }
								]
							}
						},
						{
							internalDate: String(new Date('2025-12-01T00:00:00Z').getTime()),
							payload: {
								headers: [{ name: 'From', value: 'jamie@example.com' }]
							}
						},
						{
							internalDate: String(new Date('2025-12-20T00:00:00Z').getTime()),
							payload: {
								headers: [{ name: 'Cc', value: 'family@example.com' }]
							}
						}
					]
				});
			}

			return jsonResponse({
				id: 'thread-2',
				snippet: 'quick ping',
				messages: [
					{
						internalDate: String(new Date('2022-01-01T00:00:00Z').getTime()),
						payload: {
							headers: [{ name: 'Subject', value: 'FYI' }]
						}
					}
				]
			});
		});

		const openRouterFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as {
				provider: { allow_fallbacks: boolean; data_collection: string };
			};

			expect(body.provider).toEqual({
				allow_fallbacks: false,
				data_collection: 'deny'
			});

			return jsonResponse({
				choices: [
					{
						message: {
							content: JSON.stringify({
								scores: [
									{
										threadId: 'thread-1',
										score: 0.93,
										rationale: 'Long arc with emotional weight and recurring participants',
										themes: ['change', 'family']
									}
								]
							})
						}
					}
				]
			});
		});

		const progressStages: string[] = [];
		const result = await runScanPipeline({
			accessToken: 'gmail-token',
			budget: createQuotaBudget({ maxGmailUnits: 300, maxConcurrentGmail: 3, maxConcurrentLlm: 1 }),
			fetchImpl: gmailFetch as typeof fetch,
			openRouterFetchImpl: openRouterFetch as typeof fetch,
			openRouterApiKey: 'openrouter-key',
			onProgress: (entry) => {
				progressStages.push(entry.stage);
			}
		});

		expect(result.rankedCandidates).toHaveLength(1);
		expect(result.rankedCandidates[0]).toMatchObject({
			threadId: 'thread-1',
			rank: 1
		});
		expect(progressStages).toEqual(['fetch', 'heuristics', 'llm', 'complete']);
		expect(openRouterFetch).toHaveBeenCalledTimes(1);
	});
});
