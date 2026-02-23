<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import DotsLoader from '$lib/components/ui/DotsLoader.svelte';
	import { compile } from 'mdsvex';
	import { startStoryStream, type StoryStreamHandle } from '$lib/story/client-stream';
	import type { StoryClientEvent } from '$lib/story/types';

	type PageData = {
		threadId: string;
		exploration: {
			hints?: {
				subject?: string;
				participants?: string[];
			};
		} | null;
	};

	type StoryStatus = 'loading' | 'success' | 'error';

	let { data }: { data: PageData } = $props();

	let status = $state<StoryStatus>('loading');
	let story = $state('');
	let errorMessage = $state('');
	let inFlightRequestKey = $state<string | null>(null);
	let activeAbortController = $state<AbortController | null>(null);
	let activeStreamHandle = $state<StoryStreamHandle | null>(null);
	let storyThreadId = $state<string | null>(null);
	let autoTriggerKey = $state<string | null>(null);
	let currentStatusLabel = $state('Writing your story');
	let lastStatusKey = $state<string | null>(null);
	let streamCompleted = $state(false);
	let tokenBuffer = '';
	let tokenFlushTimer: ReturnType<typeof setTimeout> | null = null;

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
			case 'gmail_reauth_required':
				return 'Gmail access needs to be reconnected. Please sign in again, then retry.';
			case 'thread_id_required':
				return 'This story handoff is missing a thread id. Please return and select a thread again.';
			case 'story_model_unavailable':
				return 'Story generation is temporarily unavailable. Please retry in a moment.';
			case 'story_gmail_request_failed':
				return 'Gmail is temporarily unavailable or rate-limited. Please retry in a moment.';
			case 'invalid_request_body':
				return 'The story request was invalid. Please retry from the candidate browser.';
			default:
				return 'We could not write this story yet. Please retry.';
		}
	}

	function flushTokenBuffer(): void {
		if (!tokenBuffer) {
			return;
		}

		story += tokenBuffer;
		tokenBuffer = '';
	}

	function scheduleTokenFlush(): void {
		if (tokenFlushTimer) {
			return;
		}

		tokenFlushTimer = setTimeout(() => {
			tokenFlushTimer = null;
			flushTokenBuffer();
		}, 40);
	}

	function applyStatusEvent(event: Extract<StoryClientEvent, { event: 'story.status' }>): void {
		const key = `${event.data.stage}:${event.data.label}`;
		if (key === lastStatusKey) {
			return;
		}

		lastStatusKey = key;
		currentStatusLabel = event.data.label;

		if (event.data.stage === 'writer.attempt.started' && Number(event.data.metadata?.attempt) > 1) {
			story = '';
			tokenBuffer = '';
		}
	}

	function handleStoryEvent(event: StoryClientEvent): void {
		switch (event.event) {
			case 'story.started': {
				streamCompleted = false;
				return;
			}
			case 'story.status': {
				applyStatusEvent(event);
				return;
			}
			case 'story.token': {
				if (event.data.token) {
					tokenBuffer += event.data.token;
					scheduleTokenFlush();
				}

				if (event.data.isFinal) {
					if (tokenFlushTimer) {
						clearTimeout(tokenFlushTimer);
						tokenFlushTimer = null;
					}
					flushTokenBuffer();
				}

				return;
			}
			case 'story.complete': {
				if (tokenFlushTimer) {
					clearTimeout(tokenFlushTimer);
					tokenFlushTimer = null;
				}
				flushTokenBuffer();
				story = event.data.story;
				storyThreadId = data.threadId;
				status = 'success';
				streamCompleted = true;
				return;
			}
			case 'story.error': {
				throw new Error(toErrorMessage(event.data.code));
			}
			case 'story.keepalive': {
				return;
			}
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
		streamCompleted = false;
		story = '';
		storyThreadId = null;
		currentStatusLabel = 'Writing your story';
		lastStatusKey = null;
		tokenBuffer = '';
		if (tokenFlushTimer) {
			clearTimeout(tokenFlushTimer);
			tokenFlushTimer = null;
		}

		try {
			const streamHandle = startStoryStream({
				threadId,
				exploration: data.exploration ?? undefined,
				signal: controller.signal,
				onEvent: (event) => {
					handleStoryEvent(event);
				}
			});
			activeStreamHandle = streamHandle;
			await streamHandle.done;

			if (!streamCompleted) {
				throw new Error(toErrorMessage('story_generation_failed'));
			}
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				return;
			}

			story = '';
			storyThreadId = null;
			errorMessage = error instanceof Error ? error.message : toErrorMessage(undefined);
			status = 'error';
		} finally {
			if (tokenFlushTimer) {
				clearTimeout(tokenFlushTimer);
				tokenFlushTimer = null;
			}

			if (activeAbortController === controller) {
				activeAbortController = null;
			}

			if (activeStreamHandle) {
				activeStreamHandle.stop();
				activeStreamHandle = null;
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
	<div class="mx-auto w-full max-w-270 px-5 sm:px-6">
		<section class="grid gap-4">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h1 class="text-[clamp(2rem,5vw,2.8rem)]">Your memory</h1>
				</div>
				<Button variant="ghost" size="sm" href="/">Back to explorer</Button>
			</div>

			{#if status === 'loading'}
				<Card className="p-[clamp(1.1rem,2.8vw,2rem)]" elevated={true}>
					<section class="grid gap-3" role="status" aria-live="polite">
						<DotsLoader label={currentStatusLabel} />
					</section>

					{#if story.trim().length > 0}
						<article
							class="story-markdown [&_pre]:text-ink-100 mt-4 font-serif text-[clamp(1.08rem,1.7vw,1.22rem)] leading-[1.88] tracking-[0.01em] [&_h1]:mt-6 [&_h1]:text-[clamp(1.5rem,3.4vw,2.1rem)] [&_h1]:leading-[1.25] [&_h2]:mt-5 [&_h2]:text-[clamp(1.2rem,2.4vw,1.45rem)] [&_h2]:leading-[1.35] [&_h3]:mt-4 [&_h3]:text-[1.08rem] [&_h3]:leading-[1.4] [&_ol]:grid [&_ol]:list-decimal [&_ol]:gap-1 [&_ol]:pl-6 [&_p]:mt-4 [&_pre]:mt-4 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-ink-900/90 [&_pre]:p-3 [&_pre]:text-[0.9rem] [&_pre]:leading-[1.6] [&_ul]:grid [&_ul]:list-disc [&_ul]:gap-1 [&_ul]:pl-6"
							aria-live="polite"
						>
							{#await compile(story) then compiled}
								{@html compiled?.code}
							{:catch}
								<p>{story}</p>
							{/await}
						</article>
					{/if}
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
					<article
						class="story-markdown [&_pre]:text-ink-100 [&_h1]:mt-2 [&_h1]:text-[clamp(1.5rem,3.4vw,2.1rem)] [&_h1]:leading-[1.25] [&_h2]:mt-5 [&_h2]:text-[clamp(1.2rem,2.4vw,1.45rem)] [&_h2]:leading-[1.35] [&_h3]:mt-4 [&_h3]:text-[1.08rem] [&_h3]:leading-[1.4] [&_ol]:grid [&_ol]:list-decimal [&_ol]:gap-1 [&_ol]:pl-6 [&_p]:mt-4 [&_pre]:mt-4 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-ink-900/90 [&_pre]:p-3 [&_pre]:text-[0.9rem] [&_pre]:leading-[1.6] [&_ul]:grid [&_ul]:list-disc [&_ul]:gap-1 [&_ul]:pl-6"
						aria-live="polite"
					>
						{#await compile(story) then compiled}
							{@html compiled?.code}
						{:catch}
							<p>{story}</p>
						{/await}
					</article>
				</Card>
			{/if}
		</section>
	</div>
</main>
