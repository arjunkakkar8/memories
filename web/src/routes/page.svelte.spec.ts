import { page } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { formatCandidateDateRange } from '$lib/ui/candidate-browser/candidate-preview';
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
	displayTitle?: string | null;
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
		displayTitle: overrides.displayTitle ?? null,
		combinedScore: 0.91,
		rank: typeof overrides.rank === 'number' ? overrides.rank : 1,
		metadata
	};
}

describe('/+page.svelte', () => {
	it('renders landing hero CTA and privacy fine print', async () => {
		render(Page, {
			data: {
				user: baseUser,
				scanEnabled: true
			}
		});

		await expect.element(page.getByRole('heading', { level: 1 })).toBeInTheDocument();
		await expect
			.element(page.getByRole('button', { name: 'Find a starting point' }))
			.toBeInTheDocument();
		await expect
			.element(
				page.getByText(
					'Email access is readonly, never persisted, and adheres to zero data retention.'
				)
			)
			.toBeInTheDocument();
	});

	it('shows auth link CTA for anonymous visitors', async () => {
		render(Page, {
			data: {
				user: null,
				scanEnabled: false
			}
		});

		await expect.element(page.getByRole('link', { name: 'Login to Gmail' })).toBeInTheDocument();
		await expect.element(page.getByText('No user is currently logged in.')).toBeInTheDocument();
	});

	it('shows animated dot loader while scan is running', async () => {
		mockStartScanStream.mockReset();
		mockStartScanStream.mockImplementationOnce(() => {
			return { stop: vi.fn(), done: new Promise(() => {}) };
		});

		render(Page, {
			data: {
				user: baseUser,
				scanEnabled: true
			}
		});

		await page.getByRole('button', { name: 'Find a starting point' }).click();
		await expect.element(page.getByRole('status')).toBeInTheDocument();
	});

	it('renders candidates as individual cards after explore', async () => {
		mockStartScanStream.mockReset();
		mockStartScanStream.mockImplementationOnce(({ onEvent }) => {
			onEvent({ event: 'scan.started', data: { startedAt: '2026-02-22T00:02:00.000Z' } });
			onEvent({
				event: 'scan.candidates',
				data: {
					batchIndex: 0,
					candidates: [
						createCandidate('First Thread', 'thread-first'),
						createCandidate('Second Thread', 'thread-second')
					]
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

		await page.getByRole('button', { name: 'Find a starting point' }).click();
		await expect.element(page.getByRole('heading', { name: 'First Thread' })).toBeInTheDocument();
		await expect.element(page.getByRole('heading', { name: 'Second Thread' })).toBeInTheDocument();
		await expect.element(page.getByRole('list', { name: 'Candidate browser' })).toBeInTheDocument();
	});

	it('renders LLM title and date range on candidate cards', async () => {
		mockStartScanStream.mockReset();

		const fallbackCandidate = createCandidate('Fallback Thread', 'thread-fallback', {
			displayTitle: 'Weekend Plans with Sam and Priya',
			participants: [],
			firstMessageAt: '2025-03-05T00:00:00.000Z',
			lastMessageAt: '2025-03-06T00:00:00.000Z',
			latestSnippet: null
		});

		mockStartScanStream.mockImplementationOnce(({ onEvent }) => {
			onEvent({ event: 'scan.started', data: { startedAt: '2026-02-22T00:03:00.000Z' } });
			onEvent({
				event: 'scan.candidates',
				data: {
					batchIndex: 0,
					candidates: [fallbackCandidate]
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

		await page.getByRole('button', { name: 'Find a starting point' }).click();

		const expectedDateRange = formatCandidateDateRange(
			fallbackCandidate.metadata.firstMessageAt,
			fallbackCandidate.metadata.lastMessageAt
		);

		await expect
			.element(page.getByRole('heading', { name: 'Weekend Plans with Sam and Priya' }))
			.toBeInTheDocument();
		await expect.element(page.getByText(`Date range: ${expectedDateRange}`)).toBeInTheDocument();
		await expect
			.element(page.getByText('A meaningful moment is waiting in this thread.'))
			.not.toBeInTheDocument();
	});

	it('removes radio selection and generate-story controls', async () => {
		mockStartScanStream.mockReset();
		mockStartScanStream.mockImplementationOnce(({ onEvent }) => {
			onEvent({
				event: 'scan.candidates',
				data: {
					batchIndex: 0,
					candidates: [createCandidate('Simple Thread', 'thread-simple')]
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

		await page.getByRole('button', { name: 'Find a starting point' }).click();
		await expect
			.element(page.getByRole('button', { name: 'Generate story' }))
			.not.toBeInTheDocument();
		await expect.element(page.getByRole('radio')).not.toBeInTheDocument();
	});

	it('navigates to story generation when a candidate card is clicked', async () => {
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

		await page.getByRole('button', { name: 'Find a starting point' }).click();
		await page.getByRole('heading', { name: 'Selection Thread' }).click();

		expect(mockGoto).toHaveBeenCalledWith(
			expect.stringMatching(/\/story\/thread-selection\?seedSubject=Selection(?:\+|%20)Thread/)
		);
	});
});
