import { page } from 'vitest/browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import StoryPage from './+page.svelte';
import { startStoryStream } from '$lib/story/client-stream';

vi.mock('$lib/story/client-stream', () => ({
	startStoryStream: vi.fn()
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((nextResolve, nextReject) => {
		resolve = nextResolve;
		reject = nextReject;
	});

	return { promise, resolve, reject };
}

describe('/story/[threadId]/+page.svelte', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('auto-triggers story generation with handoff thread id and shows loader', async () => {
		vi.mocked(startStoryStream).mockImplementation(({ onEvent }) => {
			onEvent({
				event: 'story.started',
				data: {
					startedAt: '2026-02-23T00:00:00.000Z'
				}
			});
			return {
				stop: vi.fn(),
				done: Promise.resolve()
			};
		});

		render(StoryPage, {
			data: {
				threadId: 'thread-auto-trigger',
				exploration: null
			}
		});

		await expect
			.element(page.getByRole('status', { name: 'Writing your story' }))
			.toBeInTheDocument();
		expect(startStoryStream).toHaveBeenCalledWith(
			expect.objectContaining({
				threadId: 'thread-auto-trigger',
				onEvent: expect.any(Function)
			})
		);
	});

	it('renders narrative prose when generation succeeds', async () => {
		vi.mocked(startStoryStream).mockImplementation(({ onEvent }) => {
			onEvent({
				event: 'story.started',
				data: {
					startedAt: '2026-02-23T00:00:00.000Z'
				}
			});
			onEvent({
				event: 'story.status',
				data: {
					stage: 'writer.started',
					label: 'Writing your story',
					timestamp: '2026-02-23T00:00:01.000Z'
				}
			});
			onEvent({
				event: 'story.token',
				data: {
					token: '# Memory Title\n\n## Turning point\n\nFirst paragraph.\n\nSecond paragraph.',
					index: 0,
					timestamp: '2026-02-23T00:00:02.000Z'
				}
			});
			onEvent({
				event: 'story.complete',
				data: {
					completedAt: '2026-02-23T00:00:03.000Z',
					story: '# Memory Title\n\n## Turning point\n\nFirst paragraph.\n\nSecond paragraph.',
					metadata: {
						threadId: 'thread-success',
						model: 'openai/gpt-4o-mini',
						research: {
							steps: 2,
							relatedThreads: 1,
							participantHistories: 1
						}
					}
				}
			});
			return {
				stop: vi.fn(),
				done: Promise.resolve()
			};
		});

		render(StoryPage, {
			data: {
				threadId: 'thread-success',
				exploration: null
			}
		});

		await expect.element(page.getByRole('heading', { name: 'Memory Title' })).toBeInTheDocument();
		await expect.element(page.getByText('First paragraph.')).toBeInTheDocument();
		await expect.element(page.getByText('Second paragraph.')).toBeInTheDocument();
		await expect
			.element(page.getByRole('status', { name: 'Writing your story' }))
			.not.toBeInTheDocument();
	});

	it('shows error messaging and retries without duplicate concurrent calls', async () => {
		const retryRequest = deferred<void>();
		const streamSpy = vi
			.mocked(startStoryStream)
			.mockImplementationOnce(({ onEvent }) => {
				onEvent({
					event: 'story.error',
					data: {
						code: 'story_generation_failed'
					}
				});
				return {
					stop: vi.fn(),
					done: Promise.resolve()
				};
			})
			.mockImplementationOnce(({ onEvent }) => {
				return {
					stop: vi.fn(),
					done: retryRequest.promise.then(() => {
						onEvent({
							event: 'story.complete',
							data: {
								completedAt: '2026-02-23T00:00:03.000Z',
								story: 'Recovered story output.',
								metadata: {
									threadId: 'thread-retry',
									model: 'openai/gpt-4o-mini',
									research: {
										steps: 1,
										relatedThreads: 0,
										participantHistories: 0
									}
								}
							}
						});
					})
				};
			});

		render(StoryPage, {
			data: {
				threadId: 'thread-retry',
				exploration: null
			}
		});

		await expect
			.element(page.getByText('We could not write this story yet. Please retry.'))
			.toBeInTheDocument();

		const retryButton = page.getByRole('button', { name: 'Retry story generation' });
		await retryButton.click();
		await expect
			.element(page.getByRole('status', { name: 'Writing your story' }))
			.toBeInTheDocument();
		await new Promise((resolve) => setTimeout(resolve, 25));

		expect(streamSpy).toHaveBeenCalledTimes(4);
		retryRequest.resolve();

		await expect.element(page.getByText('Recovered story output.')).toBeInTheDocument();
	});
});
