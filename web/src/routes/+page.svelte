<script lang="ts">
	import { goto } from '$app/navigation';
	import { onDestroy } from 'svelte';
	import type { SessionUser } from '$lib/server/auth/session';
	import { createCandidateStore, type ScanStoreState } from '$lib/scan/candidate-store';
	import { startScanStream, type ScanStreamHandle } from '$lib/scan/client-stream';
	import { toProgressView } from '$lib/ui/candidate-browser/progress';
	import { buildStoryHandoffHref } from '$lib/ui/candidate-browser/story-handoff';
	import {
		formatCandidateDateRange,
		toEmotionalPreview
	} from '$lib/ui/candidate-browser/candidate-preview';

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
	let selectedThreadId = $state<string | null>(null);

	const unsubscribe = candidateStore.subscribe((value) => {
		scanState = value;
	});

	onDestroy(() => {
		unsubscribe();
		activeStream?.stop();
	});

	const hasRun = $derived(scanState.runId > 0);
	const isRunning = $derived(scanState.status === 'running');
	const progressView = $derived(toProgressView(scanState.progress, scanState.candidates.length));
	const selectedCandidate = $derived(
		scanState.candidates.find((candidate) => candidate.threadId === selectedThreadId) ?? null
	);

	$effect(() => {
		if (
			selectedThreadId &&
			!scanState.candidates.some((candidate) => candidate.threadId === selectedThreadId)
		) {
			selectedThreadId = null;
		}
	});

	async function startScan(): Promise<void> {
		if (!data.scanEnabled) {
			return;
		}

		activeStream?.stop();

		const runId = candidateStore.startRun();
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
		}
	}

	function selectCandidate(threadId: string): void {
		selectedThreadId = threadId;
	}

	async function generateStory(): Promise<void> {
		const href = buildStoryHandoffHref(selectedCandidate);
		if (!href) {
			return;
		}

		await goto(href);
	}

</script>

<h1>Welcome</h1>

{#if data.user}
	<h2>Current user</h2>
	<ul>
		<li><strong>Name:</strong> {data.user.name ?? 'Unknown'}</li>
		<li><strong>Email:</strong> {data.user.email ?? 'Unknown'}</li>
		<li><strong>Subject:</strong> {data.user.subject}</li>
	</ul>

	<section aria-label="Scan pipeline">
		<h2>Scan pipeline</h2>
		<p>
			Run a scan to stream ranked memory candidates progressively. Re-scan always starts a fresh run.
		</p>

		<button type="button" onclick={startScan} disabled={!data.scanEnabled || isRunning}>
			{hasRun ? 'Re-scan' : 'Start scan'}
		</button>

		{#if isRunning}
			<p>Scan in progress...</p>
		{/if}

		{#if progressView}
			<section aria-label="Live scan progress" role="status">
				<h3>Live progress</h3>
				<p>
					<strong>Stage:</strong> {progressView.stageLabel} ({progressView.processed}/{progressView.total})
				</p>
				<p>{progressView.statusCopy}</p>
				<p>{progressView.candidateCopy}</p>
			</section>
		{/if}

		{#if scanState.status === 'error' && scanState.error}
			<p role="status">
				<strong>Scan failed:</strong> {scanState.error.message}
			</p>
		{/if}

		{#if scanState.status === 'success'}
			<p role="status">Scan complete. {scanState.totalCandidates} candidates received.</p>
		{/if}

		<h3>Candidates ({scanState.candidates.length})</h3>
		<button type="button" onclick={generateStory} disabled={!selectedCandidate}>
			Generate story
		</button>
		{#if scanState.candidates.length === 0}
			<p>No candidates yet.</p>
		{:else}
			<ul role="radiogroup" aria-label="Candidate browser">
				{#each scanState.candidates as candidate (candidate.threadId)}
					<li data-selected={candidate.threadId === selectedThreadId}>
						<article>
							<h4>{candidate.metadata.subject ?? 'Untitled thread'}</h4>
							<label>
								<input
									type="radio"
									name="selected-candidate"
									value={candidate.threadId}
									checked={candidate.threadId === selectedThreadId}
									onchange={() => selectCandidate(candidate.threadId)}
								/>
								Select {candidate.metadata.subject ?? 'candidate'}
							</label>
							{#if candidate.threadId === selectedThreadId}
								<p><strong>Selected for story generation</strong></p>
							{/if}
							<p>Rank #{candidate.rank} · score {candidate.combinedScore.toFixed(2)}</p>
							<p>
								Date range: {formatCandidateDateRange(
									candidate.metadata.firstMessageAt,
									candidate.metadata.lastMessageAt
								)}
							</p>
							<p>
								Participants:{' '}
								{candidate.metadata.participants.length > 0
									? candidate.metadata.participants.join(', ')
									: 'Unknown participants'}
							</p>
							<p>{candidate.metadata.messageCount} messages</p>
							<p>{toEmotionalPreview(candidate.metadata.latestSnippet)}</p>
						</article>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
{:else}
	<p>No user is currently logged in.</p>
{/if}
