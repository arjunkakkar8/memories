import { page } from 'vitest/browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import StoryPage from './+page.svelte';

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json'
		}
	});
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((nextResolve, nextReject) => {
		resolve = nextResolve;
		reject = nextReject;
	});

	return { promise, resolve, reject };
}

describe('/story/+page.svelte', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('auto-triggers story generation with handoff thread id and shows loader', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(jsonResponse({ story: 'The story arrives.' }));

		render(StoryPage, {
			data: {
				threadId: 'thread-auto-trigger'
			}
		});

		await expect
			.element(page.getByRole('status', { name: 'Writing your story' }))
			.toBeInTheDocument();
		expect(fetchSpy).toHaveBeenCalledWith(
			'/api/story',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ threadId: 'thread-auto-trigger' })
			})
		);
	});

	it('renders narrative prose when generation succeeds', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			jsonResponse({
				story: 'First paragraph.\n\nSecond paragraph.'
			})
		);

		render(StoryPage, {
			data: {
				threadId: 'thread-success'
			}
		});

		await expect.element(page.getByText('First paragraph.')).toBeInTheDocument();
		await expect.element(page.getByText('Second paragraph.')).toBeInTheDocument();
		await expect
			.element(page.getByRole('status', { name: 'Writing your story' }))
			.not.toBeInTheDocument();
	});

	it('shows error messaging and retries without duplicate concurrent calls', async () => {
		const retryRequest = deferred<Response>();
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(jsonResponse({ error: { code: 'story_generation_failed' } }, 502))
			.mockImplementationOnce(async () => retryRequest.promise);

		render(StoryPage, {
			data: {
				threadId: 'thread-retry'
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

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		retryRequest.resolve(jsonResponse({ story: 'Recovered story output.' }));

		await expect.element(page.getByText('Recovered story output.')).toBeInTheDocument();
	});
});
