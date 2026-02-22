<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import DotsLoader from '$lib/components/ui/DotsLoader.svelte';

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

<svelte:head>
	<title>Your story | Memories</title>
</svelte:head>

<main class="min-h-screen py-[clamp(1.25rem,3.8vw,2.75rem)]">
	<div class="mx-auto w-full max-w-[1080px] px-5 sm:px-6">
		<section class="mx-auto grid max-w-[70ch] gap-4">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<div>
					<p class="text-[0.72rem] font-bold tracking-[0.13em] text-bloom-700 uppercase">
						Memory draft
					</p>
					<h1 class="text-[clamp(2rem,5vw,2.8rem)]">Your story</h1>
				</div>
				<Button variant="ghost" size="sm" href="/">Back to explorer</Button>
			</div>

			{#if status === 'loading'}
				<Card className="p-[clamp(1.1rem,2.8vw,2rem)]" elevated={true}>
					<DotsLoader label="Writing your story" className="w-full justify-center py-[0.35rem]" />
				</Card>
			{:else if status === 'error'}
				<Card className="p-[clamp(1.1rem,2.8vw,2rem)]" elevated={true}>
					<section role="status" aria-live="assertive" class="grid gap-3">
						<h2>We hit a snag</h2>
						<p>{errorMessage}</p>
						<Button onclick={retry} disabled={inFlightRequestKey === data.threadId}>
							Retry story generation
						</Button>
					</section>
				</Card>
			{:else}
				<Card
					className="p-[clamp(1.1rem,2.8vw,2rem)] font-serif text-[clamp(1.08rem,1.7vw,1.22rem)] leading-[1.88] tracking-[0.01em]"
					elevated={true}
				>
					<article aria-live="polite">
						{#if paragraphs.length === 0}
							<p>{story}</p>
						{:else}
							{#each paragraphs as paragraph, index (`${index}-${paragraph.slice(0, 24)}`)}
								<p>{paragraph}</p>
							{/each}
						{/if}
					</article>
				</Card>
			{/if}
		</section>
	</div>
</main>
