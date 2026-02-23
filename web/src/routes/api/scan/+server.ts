import { runScanPipeline } from '$lib/server/scan/pipeline';
import { QuotaBudgetError, createQuotaBudget } from '$lib/server/scan/quota-budget';
import { getAccessToken } from '$lib/server/auth/revocable-token-store';
import { OPENROUTER_API_KEY, OPENROUTER_MODEL } from '$env/static/private';
import { toSseEvent, type ScanSseEvent } from './events';
import { createScanStreamState } from './stream-state';
import type { RequestHandler } from './$types';

const HEARTBEAT_INTERVAL_MS = 15_000;

type ScanRequestBody = {
	query?: string;
	pageSize?: number;
	maxPages?: number;
	maxThreads?: number;
	llmBatchSize?: number;
	maxGmailUnits?: number;
	maxConcurrentGmail?: number;
};

function toErrorPayload(error: unknown): Extract<ScanSseEvent, { event: 'scan.error' }>['data'] {
	if (error instanceof QuotaBudgetError) {
		return {
			code: error.code,
			message: error.message,
			recoverable: true
		};
	}

	if (error instanceof Error) {
		return {
			code: error.message,
			message: error.message,
			recoverable:
				error.message.startsWith('gmail_request_failed:') ||
				error.message.startsWith('openrouter_request_failed:')
		};
	}

	return {
		code: 'scan_unknown_error',
		message: 'Unexpected scan error',
		recoverable: false
	};
}

async function parseBody(request: Request): Promise<ScanRequestBody> {
	if (!request.headers.get('content-type')?.includes('application/json')) {
		return {};
	}

	try {
		const body = (await request.json()) as ScanRequestBody;
		return body ?? {};
	} catch {
		return {};
	}
}

export const POST: RequestHandler = async ({ locals, request, fetch }) => {
	if (!locals.session) {
		return new Response(JSON.stringify({ error: 'unauthorized' }), {
			status: 401,
			headers: {
				'content-type': 'application/json'
			}
		});
	}

	const accessToken = getAccessToken(locals.session.id);
	if (!accessToken) {
		return new Response(JSON.stringify({ error: 'gmail_access_token_missing' }), {
			status: 400,
			headers: {
				'content-type': 'application/json'
			}
		});
	}

	const body = await parseBody(request);
	const streamState = createScanStreamState();
	const encoder = new TextEncoder();

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let isClosed = false;

			const enqueue = (event: ScanSseEvent): void => {
				if (isClosed) {
					return;
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
					event: 'scan.keepalive',
					data: {
						timestamp: new Date().toISOString()
					}
				});
			}, HEARTBEAT_INTERVAL_MS);

			enqueue({
				event: 'scan.started',
				data: {
					startedAt: new Date().toISOString()
				}
			});

			void runScanPipeline({
				accessToken,
				budget: createQuotaBudget({
					maxGmailUnits: body.maxGmailUnits,
					maxConcurrentGmail: body.maxConcurrentGmail
				}),
				query: body.query,
				pageSize: body.pageSize,
				maxPages: body.maxPages,
				maxThreads: body.maxThreads,
				llmBatchSize: body.llmBatchSize,
				fetchImpl: fetch,
				openRouterFetchImpl: fetch,
				openRouterApiKey: OPENROUTER_API_KEY,
				openRouterModel: OPENROUTER_MODEL,
				onProgress: (progress) => {
					enqueue({
						event: 'scan.progress',
						data: progress
					});
				},
				onCandidateBatch: ({ batchIndex, candidates }) => {
					if (candidates.length === 0) {
						return;
					}

					streamState.markCandidatesSent(candidates);
					enqueue({
						event: 'scan.candidates',
						data: {
							batchIndex,
							candidates
						}
					});
				}
			})
				.then((result) => {
					const remainingCandidates = streamState.remainingCandidates(result.rankedCandidates);
					if (remainingCandidates.length > 0) {
						enqueue({
							event: 'scan.candidates',
							data: {
								batchIndex: -1,
								candidates: remainingCandidates
							}
						});
					}

					enqueue({
						event: 'scan.complete',
						data: {
							completedAt: new Date().toISOString(),
							totalCandidates: result.rankedCandidates.length
						}
					});
				})
				.catch((error: unknown) => {
					enqueue({
						event: 'scan.error',
						data: toErrorPayload(error)
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
		headers: {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive',
			'x-accel-buffering': 'no'
		}
	});
};
