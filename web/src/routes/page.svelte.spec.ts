import { page } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { formatCandidateDateRange, toEmotionalPreview } from '$lib/ui/candidate-browser/candidate-preview';
import { buildStoryHandoffHref } from '$lib/ui/candidate-browser/story-handoff';
import Page from './+page.svelte';

const { mockStartScanStream, mockGoto } = vi.hoisted(() => ({
	mockStartScanStream: vi.fn(),
	mockGoto: vi.fn()
}));

vi.mock('$lib/scan/client-stream', () => {
	return {
		startScanStream: mockStartScanStream
	};
});

vi.mock('$app/navigation', () => {
	return {
		goto: mockGoto
	};
});

const baseUser = {
	id: 'user-1',
	subject: 'subject-1',
	email: 'person@example.com',
	name: 'A Person'
};

type CandidateMetadataOverride = {
	subject?: string;
	participants?: string[];
	messageCount?: number;
	firstMessageAt?: string | null;
	lastMessageAt?: string | null;
	latestSnippet?: string | null;
	combinedScore?: number;
	rank?: number;
};

function createCandidate(
	subject: string,
	threadId: string,
	overrides: CandidateMetadataOverride = {}
) {
	const metadata = {
		subject,
		participants: ['person@example.com', 'friend@example.com'],
		messageCount: 14,
		firstMessageAt: '2025-01-01T00:00:00.000Z',
		lastMessageAt: '2025-01-02T00:00:00.000Z',
		latestSnippet: 'Looking forward to this memory.',
		...overrides
	};

	return {
		threadId,
		combinedScore: typeof overrides.combinedScore === 'number' ? overrides.combinedScore : 0.91,
		rank: typeof overrides.rank === 'number' ? overrides.rank : 1,
		metadata
	};
}

describe('/+page.svelte', () => {
	it('renders the scan trigger for authenticated users', async () => {
		render(Page, {
			data: {
				user: baseUser,
				scanEnabled: true
			}
		});

		const heading = page.getByRole('heading', { level: 1 });
		await expect.element(heading).toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: 'Start scan' })).toBeInTheDocument();
		await expect.element(page.getByText('No candidates yet.')).toBeInTheDocument();
	});

	it('hides scan controls for anonymous visitors', async () => {
		render(Page, {
			data: {
				user: null,
				scanEnabled: false
			}
		});

		await expect.element(page.getByText('No user is currently logged in.')).toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: 'Start scan' })).not.toBeInTheDocument();
	});

	it('keeps candidate browser heading visible after first surfaced thread', async () => {
		mockStartScanStream.mockReset();
		mockStartScanStream.mockImplementationOnce(({ onEvent }) => {
			onEvent({ event: 'scan.started', data: { startedAt: '2026-02-22T00:03:00.000Z' } });
			onEvent({
				event: 'scan.candidates',
				data: {
					batchIndex: 0,
					candidates: [createCandidate('Heading Thread', 'thread-heading')]
				}
			});
			return { stop: vi.fn(), done: Promise.resolve() };
		});

		render(Page, {
			data: {
				user: baseUser,
				scanEnabled: true
			}
		});

		await page.getByRole('button', { name: 'Start scan' }).click();
		await expect.element(page.getByRole('heading', { level: 3, name: 'Candidates (1)' })).toBeInTheDocument();
	});

	it('replaces stale candidates on re-scan', async () => {
		mockStartScanStream.mockReset();

		mockStartScanStream
			.mockImplementationOnce(({ onEvent }) => {
				onEvent({ event: 'scan.started', data: { startedAt: '2026-02-22T00:00:00.000Z' } });
				onEvent({
					event: 'scan.candidates',
					data: {
						batchIndex: 0,
						candidates: [createCandidate('Old Thread', 'thread-old')]
					}
				});
				onEvent({
					event: 'scan.complete',
					data: { completedAt: '2026-02-22T00:00:01.000Z', totalCandidates: 1 }
				});

				return { stop: vi.fn(), done: Promise.resolve() };
			})
			.mockImplementationOnce(({ onEvent }) => {
				onEvent({ event: 'scan.started', data: { startedAt: '2026-02-22T00:01:00.000Z' } });
				onEvent({
					event: 'scan.candidates',
					data: {
						batchIndex: 0,
						candidates: [createCandidate('Fresh Thread', 'thread-fresh')]
					}
				});
				onEvent({
					event: 'scan.complete',
					data: { completedAt: '2026-02-22T00:01:01.000Z', totalCandidates: 1 }
				});

				return { stop: vi.fn(), done: Promise.resolve() };
			});

		render(Page, {
			data: {
				user: baseUser,
				scanEnabled: true
			}
		});

		await page.getByRole('button', { name: 'Start scan' }).click();
		await expect.element(page.getByRole('heading', { name: 'Old Thread' })).toBeInTheDocument();

		await page.getByRole('button', { name: 'Re-scan' }).click();
		await expect.element(page.getByRole('heading', { name: 'Fresh Thread' })).toBeInTheDocument();
		await expect.element(page.getByText('Old Thread')).not.toBeInTheDocument();
	});

	it('shows human-readable progress labels and running candidate counts', async () => {
		mockStartScanStream.mockReset();

		mockStartScanStream.mockImplementationOnce(({ onEvent }) => {
			onEvent({ event: 'scan.started', data: { startedAt: '2026-02-22T00:00:00.000Z' } });
			onEvent({
				event: 'scan.progress',
				data: {
					stage: 'heuristics',
					processed: 7,
					total: 20,
					message: 'Scoring conversations with baseline heuristics.'
				}
			});
			onEvent({
				event: 'scan.candidates',
				data: {
					batchIndex: 0,
					candidates: [createCandidate('Progress Thread', 'thread-progress')]
				}
			});

			return { stop: vi.fn(), done: Promise.resolve() };
		});

		render(Page, {
			data: {
				user: baseUser,
				scanEnabled: true
			}
		});

		await page.getByRole('button', { name: 'Start scan' }).click();
		await expect.element(page.getByText(/Stage:/)).toBeInTheDocument();
		await expect.element(page.getByText(/Spotting meaningful threads/)).toBeInTheDocument();
		await expect.element(page.getByText('1 candidate surfaced')).toBeInTheDocument();
		await expect.element(page.getByRole('heading', { level: 3, name: 'Candidates (1)' })).toBeInTheDocument();
	});

	it('renders card metadata with formatted dates, participants, and preview fallback', async () => {
		mockStartScanStream.mockReset();

		const fallbackCandidate = createCandidate('Fallback Thread', 'thread-fallback', {
			participants: [],
			firstMessageAt: '2025-03-05T00:00:00.000Z',
			lastMessageAt: '2025-03-06T00:00:00.000Z',
			latestSnippet: null
		});

		mockStartScanStream.mockImplementationOnce(({ onEvent }) => {
			onEvent({ event: 'scan.started', data: { startedAt: '2026-02-22T00:02:00.000Z' } });
			onEvent({
				event: 'scan.candidates',
				data: {
					batchIndex: 0,
					candidates: [fallbackCandidate]
				}
			});
			onEvent({
				event: 'scan.complete',
				data: { completedAt: '2026-02-22T00:02:01.000Z', totalCandidates: 1 }
			});

			return { stop: vi.fn(), done: Promise.resolve() };
		});

		render(Page, {
			data: {
				user: baseUser,
				scanEnabled: true
			}
		});

		await page.getByRole('button', { name: 'Start scan' }).click();

		const expectedDateRange = formatCandidateDateRange(
			fallbackCandidate.metadata.firstMessageAt,
			fallbackCandidate.metadata.lastMessageAt
		);
		const expectedPreview = toEmotionalPreview(fallbackCandidate.metadata.latestSnippet);

		await expect.element(page.getByText(`Date range: ${expectedDateRange}`)).toBeInTheDocument();
		await expect.element(page.getByText('Participants: Unknown participants')).toBeInTheDocument();
		await expect.element(page.getByText(expectedPreview)).toBeInTheDocument();
		await expect.element(page.getByRole('radiogroup', { name: 'Candidate browser' })).toBeInTheDocument();
		await expect.element(page.getByText('Scan complete. 1 candidates received.')).toBeInTheDocument();
	});

	it('keeps generate story disabled until a candidate is selected', async () => {
		mockStartScanStream.mockReset();
		mockGoto.mockReset();

		const selectedCandidate = createCandidate('Selection Thread', 'thread-selection');

		mockStartScanStream.mockImplementationOnce(({ onEvent }) => {
			onEvent({ event: 'scan.started', data: { startedAt: '2026-02-22T00:03:00.000Z' } });
			onEvent({
				event: 'scan.candidates',
				data: {
					batchIndex: 0,
					candidates: [selectedCandidate]
				}
			});

			return { stop: vi.fn(), done: Promise.resolve() };
		});

		render(Page, {
			data: {
				user: baseUser,
				scanEnabled: true
			}
		});

		const generateStoryButton = page.getByRole('button', { name: 'Generate story' });
		await expect.element(generateStoryButton).toBeDisabled();

		await page.getByRole('button', { name: 'Start scan' }).click();
		await expect.element(generateStoryButton).toBeDisabled();

		await page.getByRole('radio', { name: /Select/ }).click();
		await expect.element(generateStoryButton).toBeEnabled();

		await generateStoryButton.click();
		const expectedHref = buildStoryHandoffHref(selectedCandidate);
		expect(mockGoto).toHaveBeenCalledWith(expectedHref);
	});

	it('clears stale selection after re-scan removes selected thread', async () => {
		mockStartScanStream.mockReset();
		mockGoto.mockReset();

		mockStartScanStream
			.mockImplementationOnce(({ onEvent }) => {
				onEvent({ event: 'scan.started', data: { startedAt: '2026-02-22T00:00:00.000Z' } });
				onEvent({
					event: 'scan.candidates',
					data: {
						batchIndex: 0,
						candidates: [createCandidate('Old Thread', 'thread-old')]
					}
				});
				onEvent({
					event: 'scan.complete',
					data: { completedAt: '2026-02-22T00:00:01.000Z', totalCandidates: 1 }
				});

				return { stop: vi.fn(), done: Promise.resolve() };
			})
			.mockImplementationOnce(({ onEvent }) => {
				onEvent({ event: 'scan.started', data: { startedAt: '2026-02-22T00:01:00.000Z' } });
				onEvent({
					event: 'scan.candidates',
					data: {
						batchIndex: 0,
						candidates: [createCandidate('Fresh Thread', 'thread-fresh')]
					}
				});
				onEvent({
					event: 'scan.complete',
					data: { completedAt: '2026-02-22T00:01:01.000Z', totalCandidates: 1 }
				});

				return { stop: vi.fn(), done: Promise.resolve() };
			});

		render(Page, {
			data: {
				user: baseUser,
				scanEnabled: true
			}
		});

		const generateStoryButton = page.getByRole('button', { name: 'Generate story' });

		await page.getByRole('button', { name: 'Start scan' }).click();
		await page.getByRole('radio', { name: /Select/ }).click();
		await expect.element(generateStoryButton).toBeEnabled();

		await page.getByRole('button', { name: 'Re-scan' }).click();
		await expect.element(page.getByRole('heading', { name: 'Fresh Thread' })).toBeInTheDocument();
		await expect.element(generateStoryButton).toBeDisabled();
		await expect.element(page.getByText('Selected for story generation')).not.toBeInTheDocument();
	});
});
