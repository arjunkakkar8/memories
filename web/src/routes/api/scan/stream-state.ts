import type { RankedScanCandidate } from '$lib/server/scan/types';

export type ScanStreamState = {
	nextEventId: () => string;
	markCandidatesSent: (candidates: RankedScanCandidate[]) => void;
	remainingCandidates: (allCandidates: RankedScanCandidate[]) => RankedScanCandidate[];
};

export function createScanStreamState(): ScanStreamState {
	let eventCounter = 0;
	const streamedThreadIds = new Set<string>();

	return {
		nextEventId: () => {
			eventCounter += 1;
			return String(eventCounter);
		},
		markCandidatesSent: (candidates) => {
			for (const candidate of candidates) {
				streamedThreadIds.add(candidate.threadId);
			}
		},
		remainingCandidates: (allCandidates) => {
			return allCandidates.filter((candidate) => !streamedThreadIds.has(candidate.threadId));
		}
	};
}
