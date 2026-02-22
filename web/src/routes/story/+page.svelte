<script lang="ts">
	type PageData = {
		threadId: string;
	};

	type StoryStatus = 'loading' | 'success' | 'error';

	type StoryApiSuccess = {
		story: string;
		metadata?: {
			threadId?: string;
		};
	};

	type StoryApiError = {
		error?: {
			code?: string;
		};
	};

	let { data }: { data: PageData } = $props();

	let status = $state<StoryStatus>('loading');
	let story = $state('');
	let errorMessage = $state('');
	let inFlightRequestKey = $state<string | null>(null);
	let activeAbortController = $state<AbortController | null>(null);
	let storyThreadId = $state<string | null>(null);
	let autoTriggerKey = $state<string | null>(null);

	const paragraphs = $derived(
		story
			.split(/\n{2,}/)
			.map((paragraph) => paragraph.trim())
			.filter(Boolean)
	);

	$effect(() => {
		const key = data.threadId;
		if (autoTriggerKey === key) {
			return;
		}

		autoTriggerKey = key;
		void requestStory(key);
	});

	function toErrorMessage(code: string | undefined): string {
		switch (code) {
			case 'unauthorized':
				return 'Your session expired. Please sign in again, then retry.';
			case 'gmail_access_token_missing':
				return 'We could not access Gmail for this session. Reconnect and try again.';
			case 'thread_id_required':
				return 'This story handoff is missing a thread id. Please return and select a thread again.';
			case 'story_model_unavailable':
				return 'Story generation is temporarily unavailable. Please retry in a moment.';
			case 'invalid_request_body':
				return 'The story request was invalid. Please retry from the candidate browser.';
			default:
				return 'We could not write this story yet. Please retry.';
		}
	}

	async function requestStory(threadId: string, force = false): Promise<void> {
		if (inFlightRequestKey === threadId) {
			return;
		}

		if (!force) {
			if (status === 'success' && storyThreadId === threadId) {
				return;
			}
		}

		if (activeAbortController && inFlightRequestKey && inFlightRequestKey !== threadId) {
			activeAbortController.abort();
		}

		const controller = new AbortController();
		activeAbortController = controller;
		inFlightRequestKey = threadId;
		status = 'loading';
		errorMessage = '';

		try {
			const response = await fetch('/api/story', {
				method: 'POST',
				headers: {
					'content-type': 'application/json'
				},
				body: JSON.stringify({ threadId }),
				signal: controller.signal
			});

			if (!response.ok) {
				const payload = (await response.json().catch(() => null)) as StoryApiError | null;
				throw new Error(toErrorMessage(payload?.error?.code));
			}

			const payload = (await response.json()) as StoryApiSuccess;
			const nextStory = payload.story?.trim();
			if (!nextStory) {
				throw new Error(toErrorMessage('story_generation_failed'));
			}

			story = nextStory;
			storyThreadId = threadId;
			status = 'success';
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				return;
			}

			story = '';
			storyThreadId = null;
			errorMessage = error instanceof Error ? error.message : toErrorMessage(undefined);
			status = 'error';
		} finally {
			if (activeAbortController === controller) {
				activeAbortController = null;
			}

			if (inFlightRequestKey === threadId) {
				inFlightRequestKey = null;
			}
		}
	}

	async function retry(): Promise<void> {
		void requestStory(data.threadId, true);
	}
</script>

<main class="story-page">
	<section class="story-shell">
		<header class="story-header">
			<p class="eyebrow">Memory draft</p>
			<h1>Your story</h1>
		</header>

		{#if status === 'loading'}
			<p class="status" role="status" aria-live="polite">Writing your story...</p>
		{:else if status === 'error'}
			<section class="status error" role="status" aria-live="assertive">
				<h2>We hit a snag</h2>
				<p>{errorMessage}</p>
				<button type="button" onclick={retry} disabled={inFlightRequestKey === data.threadId}>
					Retry story generation
				</button>
			</section>
		{:else}
			<article class="reader" aria-live="polite">
				{#if paragraphs.length === 0}
					<p>{story}</p>
				{:else}
					{#each paragraphs as paragraph, index (`${index}-${paragraph.slice(0, 24)}`)}
						<p>{paragraph}</p>
					{/each}
				{/if}
			</article>
		{/if}
	</section>
</main>

<style>
	.story-page {
		min-height: 100vh;
		padding: clamp(1.25rem, 3.5vw, 3rem);
		background: linear-gradient(180deg, #f4efe7 0%, #f9f7f2 35%, #fffefb 100%);
	}

	.story-shell {
		max-width: 68ch;
		margin: 0 auto;
		display: grid;
		gap: 1.5rem;
		color: #221d16;
	}

	.story-header {
		display: grid;
		gap: 0.5rem;
	}

	.eyebrow {
		margin: 0;
		font: 600 0.75rem/1.1 'Avenir Next', 'Helvetica Neue', sans-serif;
		text-transform: uppercase;
		letter-spacing: 0.12em;
		color: #5f4c37;
	}

	h1 {
		margin: 0;
		font: 500 clamp(2rem, 5vw, 2.8rem) / 1.1 'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', serif;
	}

	.status,
	.reader {
		margin: 0;
		padding: clamp(1.25rem, 3vw, 2rem);
		background: rgb(255 255 255 / 75%);
		border: 1px solid rgb(82 65 43 / 12%);
		box-shadow: 0 10px 28px rgb(35 28 20 / 10%);
		border-radius: 1rem;
	}

	.status {
		font: 500 1.05rem/1.6 'Avenir Next', 'Helvetica Neue', sans-serif;
	}

	.error {
		display: grid;
		gap: 0.9rem;
	}

	.error h2 {
		margin: 0;
		font: 600 1.25rem/1.2 'Avenir Next', 'Helvetica Neue', sans-serif;
	}

	.error p {
		margin: 0;
	}

	button {
		justify-self: start;
		padding: 0.7rem 1.1rem;
		font: 600 0.95rem/1 'Avenir Next', 'Helvetica Neue', sans-serif;
		color: #fff;
		background: #513620;
		border: 0;
		border-radius: 999px;
		cursor: pointer;
	}

	button:disabled {
		opacity: 0.65;
		cursor: wait;
	}

	.reader {
		font: 400 1.17rem/1.88 'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', serif;
		letter-spacing: 0.01em;
	}

	.reader p {
		margin: 0;
	}

	.reader p + p {
		margin-top: 1.25rem;
	}

	@media (max-width: 640px) {
		.story-page {
			padding: 1rem;
		}

		.status,
		.reader {
			padding: 1rem;
		}

		.reader {
			font-size: 1.06rem;
			line-height: 1.8;
		}
	}
</style>
