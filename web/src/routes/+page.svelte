<script lang="ts">
	import { goto } from '$app/navigation';
	import { onDestroy } from 'svelte';
	import type { SessionUser } from '$lib/server/auth/session';
	import { createCandidateStore, type ScanStoreState } from '$lib/scan/candidate-store';
	import { startScanStream, type ScanStreamHandle } from '$lib/scan/client-stream';
	import { buildStoryHandoffHref } from '$lib/ui/candidate-browser/story-handoff';
	import {
		formatCandidateDateRange,
		toEmotionalPreview
	} from '$lib/ui/candidate-browser/candidate-preview';
	import Button from '$lib/components/ui/Button.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import DotsLoader from '$lib/components/ui/DotsLoader.svelte';

	type PageData = {
		user: SessionUser | null;
		scanEnabled: boolean;
	};

	let { data }: { data: PageData } = $props();

	const candidateStore = createCandidateStore();
	let scanState = $state<ScanStoreState>({
		runId: 0,
		status: 'idle',
		startedAt: null,
		completedAt: null,
		progress: null,
		candidates: [],
		totalCandidates: 0,
		error: null
	});
	let activeStream: ScanStreamHandle | null = null;
	let isHeroTransitioning = $state(false);
	let heroTransitionTimer: ReturnType<typeof setTimeout> | null = null;
  let heroHeight = $state(0);

	const unsubscribe = candidateStore.subscribe((value) => {
		scanState = value;
	});

	onDestroy(() => {
		unsubscribe();
		activeStream?.stop();
		if (heroTransitionTimer) {
			clearTimeout(heroTransitionTimer);
			heroTransitionTimer = null;
		}
	});

	const hasRun = $derived(scanState.runId > 0);
	const isRunning = $derived(scanState.status === 'running');
	const shouldCenterContent = $derived(
		!hasRun &&
			!isRunning &&
			scanState.status !== 'error' &&
			scanState.candidates.length === 0 &&
			!isHeroTransitioning
	);
	const isExploreDisabled = $derived(!data.scanEnabled || isRunning || isHeroTransitioning);

	async function startScan(): Promise<void> {
		if (!data.scanEnabled) {
			return;
		}

		activeStream?.stop();
		isHeroTransitioning = true;
		await new Promise<void>((resolve) => {
			heroTransitionTimer = setTimeout(() => {
				heroTransitionTimer = null;
				resolve();
			}, 320);
		});

		if (heroTransitionTimer !== null) {
			return;
		}

		const runId = candidateStore.startRun();
		isHeroTransitioning = false;
		const stream = startScanStream({
			onEvent: (event) => {
				candidateStore.applyEvent(runId, event);
			}
		});

		activeStream = stream;

		try {
			await stream.done;
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				return;
			}

			candidateStore.setRunError(
				runId,
				error instanceof Error ? error.message : 'Unexpected scan client error'
			);
		} finally {
			if (activeStream === stream) {
				activeStream = null;
			}

			if (scanState.status !== 'running') {
				isHeroTransitioning = false;
			}
		}
	}

	async function openCandidateStory(href: string, event: MouseEvent): Promise<void> {
		event.preventDefault();
		await goto(href);
	}
</script>

<svelte:head>
	<title>Memories | Surface story-worthy email threads</title>
</svelte:head>

<main class="min-h-screen py-[clamp(1.25rem,3.8vw,2.75rem)]">
    <div class="mx-auto w-full max-w-270 px-5 sm:px-6">

	<div
		class={`transition-[height] duration-500 ease-out flex flex-col justify-center ${shouldCenterContent ? 'h-[calc(100vh-5.5rem)]': 'h-(--hero-height)'}`}
    style:--hero-height="{heroHeight}px"
	>
		<section
			class="mb-4 grid justify-items-center gap-6 px-[clamp(0.35rem,2.1vw,1.25rem)] py-[clamp(1.45rem,4.4vw,3.1rem)] text-center"
			aria-label="Memories landing hero"
      bind:clientHeight={heroHeight}
		>
			<h1 class="max-w-[20ch] text-[clamp(2.3rem,6.3vw,4.3rem)] text-balance">
				Turn your emails <br /> into readable <i>memories</i>.
			</h1>
			<p class="max-w-[68ch] text-[clamp(1.02rem,2.4vw,1.2rem)] text-ink-muted">
				Email access is readonly, never persisted, and adheres to zero data retention.
			</p>
			<div class="grid justify-items-center gap-2">
				{#if data.user}
					<Button onclick={startScan} disabled={isExploreDisabled}>
						{hasRun && !isRunning ? 'Find More Seeds' : 'Find a starting point'}
					</Button>
				{:else}
					<Button href="/auth/google">Login to Gmail</Button>
				{/if}
			</div>
		</section>
      </div>

		{#if data.user}
			<section
				aria-label="Candidate browser"
				class={`${shouldCenterContent ? 'grid gap-4' : 'mt-5 grid gap-4'}`}
			>
				{#if isRunning}
					<div class="flex w-full justify-center">
						<DotsLoader label="Scan in progress" />
					</div>
				{/if}

				{#if scanState.status === 'error' && scanState.error}
					<p class="text-ink-muted" role="status">
						We could not load memory candidates right now. Please try exploring again.
					</p>
				{/if}

				{#if scanState.candidates.length > 0}
					<ul
						class="m-0 grid list-none grid-cols-1 gap-3 p-0 md:grid-cols-2 xl:grid-cols-3"
						aria-label="Candidate browser"
					>
						{#each scanState.candidates as candidate (candidate.threadId)}
							{@const candidateHref =
								buildStoryHandoffHref(candidate) ??
								`/story?threadId=${encodeURIComponent(candidate.threadId)}`}
							<li>
								<Card className="grid gap-3 p-[0.85rem]" elevated={true}>
									<a
										href={candidateHref}
										class="grid gap-2 rounded-[0.6rem] border border-transparent bg-transparent p-[0.1rem] text-left no-underline transition-transform duration-150 hover:-translate-y-px"
										onclick={(event) => openCandidateStory(candidateHref, event)}
									>
										<h2 class="text-[1.08rem]">
											{candidate.metadata.subject ?? 'Untitled thread'}
										</h2>
										<p class="text-[0.9rem] text-ink-body">
											Date range: {formatCandidateDateRange(
												candidate.metadata.firstMessageAt,
												candidate.metadata.lastMessageAt
											)}
										</p>
										<p class="text-[0.9rem] text-ink-body">
											{toEmotionalPreview(candidate.metadata.latestSnippet)}
										</p>
									</a>
								</Card>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{:else}
			<Card className="grid gap-3 p-4" elevated={true}>
				<h2>Connect your inbox to begin</h2>
				<p class="text-ink-muted">
					No user is currently logged in. Sign in with Gmail to explore memory candidates and write
					stories.
				</p>
				<Button href="/auth/google">Sign in with Google</Button>
			</Card>
		{/if}
	</div>
</main>
