import type { ScanProgress } from '$lib/scan/candidate-store';

export const STAGE_LABELS: Record<ScanProgress['stage'], string> = {
	fetch: 'Collecting conversations',
	heuristics: 'Spotting meaningful threads',
	llm: 'Refining story potential',
	complete: 'Scan complete'
};

type ProgressView = {
	stageLabel: string;
	statusCopy: string;
	candidateCopy: string;
	processed: number;
	total: number;
};

export function toProgressView(
	progress: ScanProgress | null,
	candidateCount: number
): ProgressView | null {
	if (!progress) {
		return null;
	}

	const stageLabel = STAGE_LABELS[progress.stage];
	const safeProcessed = Number.isFinite(progress.processed) ? Math.max(0, progress.processed) : 0;
	const safeTotal = Number.isFinite(progress.total) ? Math.max(0, progress.total) : 0;
	const boundedProcessed = safeTotal > 0 ? Math.min(safeProcessed, safeTotal) : safeProcessed;
	const statusMessage = progress.message.trim();

	return {
		stageLabel,
		statusCopy:
			statusMessage.length > 0 ? statusMessage : `${stageLabel} (${boundedProcessed}/${safeTotal})`,
		candidateCopy: `${candidateCount} ${candidateCount === 1 ? 'candidate' : 'candidates'} surfaced`,
		processed: boundedProcessed,
		total: safeTotal
	};
}
