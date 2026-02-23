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

function threadMetadataResponse(
	threadId: string,
	options: { subject: string; snippet: string; messageCount: number }
) {
	const messages = Array.from({ length: options.messageCount }, (_, index) => ({
		internalDate: String(new Date(`2025-0${Math.min(index + 1, 9)}-01T00:00:00Z`).getTime()),
		labelIds: index % 2 === 0 ? ['IMPORTANT'] : [],
		payload: {
			headers: [
				{ name: 'Subject', value: options.subject },
				{ name: 'From', value: 'alex@example.com' },
				{ name: 'To', value: 'jamie@example.com' }
			]
		}
	}));

	return {
		id: threadId,
		snippet: options.snippet,
		messages
	};
}

describe('runScanPipeline', () => {
	it('materializes random windows using after/before epoch seconds', async () => {
		const seenQueries: string[] = [];

		const gmailFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(typeof input === 'string' ? input : input.toString());

			if (url.pathname.endsWith('/threads')) {
				seenQueries.push(url.searchParams.get('q') ?? '');
				return jsonResponse({
					threads: [{ id: 'thread-1' }, { id: 'thread-2' }, { id: 'thread-3' }]
				});
			}

			const threadId = url.pathname.split('/').pop() ?? 'thread-1';
			return jsonResponse(
				threadMetadataResponse(threadId, {
					subject: `Subject ${threadId}`,
					snippet: `Update ${threadId}`,
					messageCount: 2
				})
			);
		});

		await runScanPipeline({
			accessToken: 'gmail-token',
			budget: createQuotaBudget({ maxGmailUnits: 500, maxConcurrentGmail: 3, maxConcurrentLlm: 1 }),
			fetchImpl: gmailFetch as typeof fetch,
			runtimeConfig: {
				randomWindows: {
					count: 2,
					durationDaysOptions: [7],
					maxLookbackDays: 180,
					maxOverlapRatio: 1
				},
				queryPacks: {
					ids: ['inbox-focus'],
					defaultFetchBudget: {
						pageSize: 20,
						maxPages: 1,
						maxThreads: 20
					}
				}
			}
		});

		expect(seenQueries).toHaveLength(2);
		for (const query of seenQueries) {
			expect(query).toContain('after:');
			expect(query).toContain('before:');
		}
	});

	it('guarantees at least 5 ranked candidates when enough threads were retrieved', async () => {
		const gmailFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(typeof input === 'string' ? input : input.toString());

			if (url.pathname.endsWith('/threads')) {
				return jsonResponse({
					threads: [
						{ id: 'thread-1' },
						{ id: 'thread-2' },
						{ id: 'thread-3' },
						{ id: 'thread-4' },
						{ id: 'thread-5' },
						{ id: 'thread-6' }
					]
				});
			}

			const threadId = url.pathname.split('/').pop() ?? 'thread-1';
			return jsonResponse(
				threadMetadataResponse(threadId, {
					subject: `Receipt ${threadId}`,
					snippet: 'invoice order confirmation',
					messageCount: 1
				})
			);
		});

		const progressStages: string[] = [];
		const result = await runScanPipeline({
			accessToken: 'gmail-token',
			budget: createQuotaBudget({ maxGmailUnits: 800, maxConcurrentGmail: 3, maxConcurrentLlm: 1 }),
			fetchImpl: gmailFetch as typeof fetch,
			onProgress: (entry) => {
				progressStages.push(entry.stage);
			},
			runtimeConfig: {
				randomWindows: {
					count: 1,
					durationDaysOptions: [30],
					maxLookbackDays: 365,
					maxOverlapRatio: 1
				},
				queryPacks: {
					ids: ['inbox-focus'],
					defaultFetchBudget: {
						pageSize: 100,
						maxPages: 1,
						maxThreads: 50
					}
				}
			}
		});

		expect(result.rankedCandidates).toHaveLength(5);
		expect(new Set(result.rankedCandidates.map((entry) => entry.threadId)).size).toBe(5);
		expect(progressStages).toContain('fetch');
		expect(progressStages).toContain('heuristics');
		expect(progressStages).toContain('llm');
		expect(progressStages).toContain('complete');
	});

	it('runs a single LLM batch for reranking and title generation', async () => {
		const gmailFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(typeof input === 'string' ? input : input.toString());

			if (url.pathname.endsWith('/threads')) {
				return jsonResponse({
					threads: [
						{ id: 'thread-1' },
						{ id: 'thread-2' },
						{ id: 'thread-3' },
						{ id: 'thread-4' },
						{ id: 'thread-5' },
						{ id: 'thread-6' }
					]
				});
			}

			const threadId = url.pathname.split('/').pop() ?? 'thread-1';
			return jsonResponse(
				threadMetadataResponse(threadId, {
					subject: `Planning sync ${threadId}`,
					snippet: `Decision points and next steps for ${threadId}`,
					messageCount: 4
				})
			);
		});

		const llmFetch = vi.fn(async () => {
			return jsonResponse({
				choices: [
					{
						message: {
							content: JSON.stringify({
								scores: [
									{
										threadId: 'thread-1',
										score: 0.8,
										rationale: 'Good continuity',
										themes: ['planning'],
										title: 'Planning Sync with Product Team'
									},
									{
										threadId: 'thread-2',
										score: 0.75,
										rationale: 'Clear action items',
										themes: ['delivery'],
										title: 'Delivery Milestones and Owners'
									},
									{
										threadId: 'thread-3',
										score: 0.74,
										rationale: 'Strong context',
										themes: ['alignment'],
										title: 'Alignment Notes from Weekly Check-in'
									},
									{
										threadId: 'thread-4',
										score: 0.73,
										rationale: 'Useful decisions',
										themes: ['decision'],
										title: 'Decisions from Stakeholder Review'
									},
									{
										threadId: 'thread-5',
										score: 0.72,
										rationale: 'Recent and active',
										themes: ['updates'],
										title: 'Recent Updates and Open Questions'
									},
									{
										threadId: 'thread-6',
										score: 0.71,
										rationale: 'Good momentum',
										themes: ['momentum'],
										title: 'Momentum Check and Next Steps'
									}
								]
							})
						}
					}
				]
			});
		});

		const result = await runScanPipeline({
			accessToken: 'gmail-token',
			budget: createQuotaBudget({ maxGmailUnits: 800, maxConcurrentGmail: 3, maxConcurrentLlm: 1 }),
			fetchImpl: gmailFetch as typeof fetch,
			openRouterFetchImpl: llmFetch as typeof fetch,
			openRouterApiKey: 'openrouter-test-key',
			runtimeConfig: {
				randomWindows: {
					count: 1,
					durationDaysOptions: [30],
					maxLookbackDays: 365,
					maxOverlapRatio: 1
				},
				queryPacks: {
					ids: ['inbox-focus'],
					defaultFetchBudget: {
						pageSize: 100,
						maxPages: 1,
						maxThreads: 50
					}
				}
			}
		});

		expect(llmFetch).toHaveBeenCalledTimes(1);
		expect(result.rankedCandidates.length).toBeGreaterThanOrEqual(5);
		expect(result.rankedCandidates.every((candidate) => Boolean(candidate.displayTitle))).toBe(
			true
		);
	});
});
