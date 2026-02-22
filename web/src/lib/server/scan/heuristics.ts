import type { HeuristicCandidate, HeuristicFilterResult, HeuristicSignalBundle, ScanThreadMetadata } from './types';

type HeuristicOptions = {
	now?: Date;
	minTotalScore?: number;
	minMessageCount?: number;
};

function clampScore(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function recencyScore(lastMessageAt: string | null, now: Date): number {
	if (!lastMessageAt) {
		return 0;
	}

	const ageMs = now.getTime() - new Date(lastMessageAt).getTime();
	if (!Number.isFinite(ageMs) || ageMs < 0) {
		return 0;
	}

	const ageDays = ageMs / (1000 * 60 * 60 * 24);
	return clampScore(1 - ageDays / 365);
}

function continuityScore(metadata: ScanThreadMetadata): number {
	if (!metadata.firstMessageAt || !metadata.lastMessageAt || metadata.messageCount <= 1) {
		return 0;
	}

	const spanMs =
		new Date(metadata.lastMessageAt).getTime() - new Date(metadata.firstMessageAt).getTime();
	if (!Number.isFinite(spanMs) || spanMs <= 0) {
		return 0;
	}

	const spanDays = spanMs / (1000 * 60 * 60 * 24);
	const sustainedConversationFactor = clampScore(spanDays / 60);
	const depthFactor = clampScore((metadata.messageCount - 1) / 10);

	return clampScore(sustainedConversationFactor * 0.6 + depthFactor * 0.4);
}

export function scoreCandidate(metadata: ScanThreadMetadata, now = new Date()): HeuristicSignalBundle {
	const messageDepth = clampScore((metadata.messageCount - 1) / 12);
	const participantDiversity = clampScore((metadata.participants.length - 1) / 5);
	const recency = recencyScore(metadata.lastMessageAt, now);
	const continuity = continuityScore(metadata);

	const total = clampScore(
		messageDepth * 0.35 + participantDiversity * 0.2 + recency * 0.2 + continuity * 0.25
	);

	return {
		messageDepth,
		participantDiversity,
		recency,
		continuity,
		total
	};
}

export function filterCandidates(
	metadata: ScanThreadMetadata[],
	options: HeuristicOptions = {}
): HeuristicFilterResult {
	const now = options.now ?? new Date();
	const minTotalScore = options.minTotalScore ?? 0.42;
	const minMessageCount = options.minMessageCount ?? 2;

	const kept: HeuristicCandidate[] = [];
	const dropped: HeuristicCandidate[] = [];

	for (const candidate of metadata) {
		const signals = scoreCandidate(candidate, now);
		const normalized: HeuristicCandidate = {
			metadata: candidate,
			signals
		};

		if (candidate.messageCount < minMessageCount || signals.total < minTotalScore) {
			dropped.push(normalized);
			continue;
		}

		kept.push(normalized);
	}

	kept.sort((left, right) => {
		if (right.signals.total !== left.signals.total) {
			return right.signals.total - left.signals.total;
		}

		return right.metadata.messageCount - left.metadata.messageCount;
	});

	return { kept, dropped };
}
