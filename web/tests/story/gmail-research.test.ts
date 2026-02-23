import { describe, expect, it, vi } from 'vitest';
import {
	fetchSelectedThread,
	searchThreadsByConcept,
	searchThreadsByTimeWindow
} from '../../src/lib/server/story/gmail-research';

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json'
		}
	});
}

describe('fetchSelectedThread', () => {
	it('classifies metadata-scope full-format failures with stable reason code', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse(
				{
					error: {
						message: "Metadata scope doesn't allow format FULL",
						errors: [{ reason: 'forbidden' }]
					}
				},
				403
			)
		);

		await expect(
			fetchSelectedThread('thread-123', {
				accessToken: 'token',
				fetchImpl: fetchImpl as never
			})
		).rejects.toThrow('gmail_request_failed:403:threads.get:metadataScopeFullFormatForbidden');

		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('fails immediately for non-retryable forbidden reasons', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse(
				{
					error: {
						message: 'Access denied',
						errors: [{ reason: 'forbidden' }]
					}
				},
				403
			)
		);

		await expect(
			fetchSelectedThread('thread-123', {
				accessToken: 'token',
				fetchImpl: fetchImpl as never
			})
		).rejects.toThrow('gmail_request_failed:403:threads.get:forbidden');

		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('paginates thread listing, deduplicates thread ids, and tags concept provenance', async () => {
		const fetchImpl = vi.fn((input: RequestInfo | URL) => {
			const url = new URL(typeof input === 'string' ? input : input.toString());

			if (url.pathname.endsWith('/threads') && !url.pathname.includes('/threads/')) {
				const pageToken = url.searchParams.get('pageToken');
				if (!pageToken) {
					return Promise.resolve(
						jsonResponse({
							threads: [{ id: 'selected-thread' }, { id: 't-1' }, { id: 't-2' }],
							nextPageToken: 'page-2'
						})
					);
				}

				return Promise.resolve(
					jsonResponse({
						threads: [{ id: 't-2' }, { id: 't-3' }]
					})
				);
			}

			if (url.pathname.endsWith('/threads/t-1')) {
				return Promise.resolve(
					jsonResponse({
						id: 't-1',
						historyId: '1',
						messages: [
							{
								id: 'm-1',
								internalDate: String(Date.parse('2026-01-01T00:00:00.000Z')),
								snippet: 'Snippet 1',
								payload: {
									headers: [
										{ name: 'Subject', value: 'Launch planning' },
										{ name: 'From', value: 'alex@example.com' },
										{ name: 'To', value: 'jamie@example.com' }
									]
								}
							}
						]
					})
				);
			}

			if (url.pathname.endsWith('/threads/t-2')) {
				return Promise.resolve(
					jsonResponse({
						id: 't-2',
						historyId: '2',
						messages: [
							{
								id: 'm-2',
								internalDate: String(Date.parse('2026-01-02T00:00:00.000Z')),
								snippet: 'Snippet 2',
								payload: {
									headers: [
										{ name: 'Subject', value: 'Launch planning follow-up' },
										{ name: 'From', value: 'jamie@example.com' },
										{ name: 'To', value: 'alex@example.com' }
									]
								}
							}
						]
					})
				);
			}

			return Promise.resolve(
				jsonResponse({
					id: 't-3',
					historyId: '3',
					messages: [
						{
							id: 'm-3',
							internalDate: String(Date.parse('2026-01-03T00:00:00.000Z')),
							snippet: 'Snippet 3',
							payload: {
								headers: [
									{ name: 'Subject', value: 'Launch retrospective' },
									{ name: 'From', value: 'kai@example.com' },
									{ name: 'To', value: 'alex@example.com' }
								]
							}
						}
					]
				})
			);
		});

		const results = await searchThreadsByConcept({
			accessToken: 'token',
			fetchImpl: fetchImpl as never,
			selectedThreadId: 'selected-thread',
			concept: 'launch',
			maxResults: 3,
			searchPageSize: 3,
			searchMaxPages: 2,
			detailBatchSize: 2
		});

		expect(results.map((thread) => thread.threadId)).toEqual(['t-1', 't-2', 't-3']);
		expect(
			results.every((thread) => thread.provenance[0]?.source === 'search_threads_by_concept')
		).toBe(true);

		const listCalls = fetchImpl.mock.calls.filter((call) =>
			new URL(String(call[0])).pathname.endsWith('/threads')
		);
		expect(listCalls).toHaveLength(2);
	});

	it('builds explicit after/before Gmail query for timeline-window search', async () => {
		const fetchImpl = vi.fn((input: RequestInfo | URL) => {
			const url = new URL(typeof input === 'string' ? input : input.toString());

			if (url.pathname.endsWith('/threads') && !url.pathname.includes('/threads/')) {
				return Promise.resolve(
					jsonResponse({
						threads: [{ id: 'timeline-thread' }]
					})
				);
			}

			return Promise.resolve(
				jsonResponse({
					id: 'timeline-thread',
					historyId: '1',
					messages: [
						{
							id: 'm-1',
							internalDate: String(Date.parse('2026-01-02T00:00:00.000Z')),
							snippet: 'Window thread',
							payload: {
								headers: [
									{ name: 'Subject', value: 'Window thread' },
									{ name: 'From', value: 'alex@example.com' },
									{ name: 'To', value: 'jamie@example.com' }
								]
							}
						}
					]
				})
			);
		});

		await searchThreadsByTimeWindow({
			accessToken: 'token',
			fetchImpl: fetchImpl as never,
			selectedThreadId: 'selected-thread',
			after: '2026-01-01T00:00:00.000Z',
			before: '2026-01-10T00:00:00.000Z',
			maxResults: 1
		});

		const listCall = fetchImpl.mock.calls.find((call) =>
			new URL(String(call[0])).pathname.endsWith('/threads')
		);
		expect(listCall).toBeTruthy();
		const query = new URL(String(listCall?.[0])).searchParams.get('q') ?? '';
		expect(query).toContain('after:2026/01/01');
		expect(query).toContain('before:2026/01/10');
	});
});
