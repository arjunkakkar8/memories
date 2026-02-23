import type {
	HeuristicCandidate,
	HeuristicFilterResult,
	HeuristicSignalBundle,
	ScanThreadMetadata
} from './types';
import {
	DEFAULT_HEURISTIC_PENALTY_WEIGHTS,
	DEFAULT_HEURISTIC_THRESHOLDS,
	DEFAULT_HEURISTIC_WEIGHTS,
	type HeuristicPenaltyWeights,
	type HeuristicWeights
} from './config';

type HeuristicOptions = {
	now?: Date;
	minTotalScore?: number;
	minMessageCount?: number;
	weights?: Partial<HeuristicWeights>;
	penaltyWeights?: Partial<HeuristicPenaltyWeights>;
};

function clampScore(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}

	return Math.max(0, Math.min(1, value));
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
	const sustainedConversationFactor = clampScore(spanDays / 120);
	const depthFactor = clampScore((metadata.messageCount - 1) / 12);

	return clampScore(sustainedConversationFactor * 0.55 + depthFactor * 0.45);
}

function countTerms(text: string, tokens: string[]): number {
	let total = 0;
	for (const token of tokens) {
		if (text.includes(token)) {
			total += 1;
		}
	}

	return total;
}

function actionabilityLexicalScore(metadata: ScanThreadMetadata): number {
	const lexical = `${metadata.subjectLexical} ${metadata.snippetLexical}`.trim();
	if (!lexical) {
		return 0;
	}

	const positiveTokens = [
		'plan',
		'confirm',
		'deadline',
		'follow up',
		'next step',
		'important',
		'update',
		'thank you',
		'call',
		'meet',
		'please',
		'reply'
	];

	return clampScore(countTerms(lexical, positiveTokens) / 6);
}

function resurfacingScore(metadata: ScanThreadMetadata): number {
	if (!metadata.firstMessageAt || !metadata.lastMessageAt || metadata.messageCount < 2) {
		return 0;
	}

	const spanDays =
		(new Date(metadata.lastMessageAt).getTime() - new Date(metadata.firstMessageAt).getTime()) /
		(1000 * 60 * 60 * 24);
	if (!Number.isFinite(spanDays) || spanDays <= 0) {
		return 0;
	}

	const longSpan = clampScore(spanDays / 90);
	const enoughDepth = clampScore(metadata.messageCount / 8);
	return clampScore(longSpan * 0.6 + enoughDepth * 0.4);
}

function historicalPersistenceScore(metadata: ScanThreadMetadata): number {
	const packCoverage = clampScore(metadata.retrieval.packIds.length / 3);
	const windowCoverage = clampScore(metadata.retrieval.windowIds.length / 4);
	const hitDepth = clampScore(metadata.retrieval.hitCount / 6);
	return clampScore(packCoverage * 0.45 + windowCoverage * 0.3 + hitDepth * 0.25);
}

function noveltyScore(metadata: ScanThreadMetadata): number {
	if (metadata.retrieval.hitCount <= 1) {
		return 1;
	}

	return clampScore(1 / metadata.retrieval.hitCount);
}

function importanceMarkerScore(metadata: ScanThreadMetadata): number {
	let score = 0;
	if (metadata.importanceMarkers.important) {
		score += 0.45;
	}
	if (metadata.importanceMarkers.starred) {
		score += 0.35;
	}
	if (metadata.importanceMarkers.hasUserLabels) {
		score += 0.2;
	}

	return clampScore(score);
}

function bulkNoisePenalty(metadata: ScanThreadMetadata): number {
	const lexical = `${metadata.subjectLexical} ${metadata.snippetLexical}`.trim();
	if (!lexical) {
		return 0;
	}

	const tokens = [
		'unsubscribe',
		'newsletter',
		'promotion',
		'digest',
		'advertisement',
		'sale',
		'limited time',
		'offer'
	];
	const tokenDensity = countTerms(lexical, tokens) / 6;
	const participantPenalty = metadata.participantsNormalized.length <= 1 ? 0.2 : 0;

	return clampScore(tokenDensity + participantPenalty);
}

function receiptAutoMailPenalty(metadata: ScanThreadMetadata): number {
	const lexical = `${metadata.subjectLexical} ${metadata.snippetLexical}`.trim();
	const tokens = ['receipt', 'invoice', 'order', 'payment', 'tracking', 'shipment', 'no reply'];
	return clampScore(countTerms(lexical, tokens) / 5);
}

function redundancyPenalty(metadata: ScanThreadMetadata): number {
	const lexical = metadata.subjectLexical;
	if (!lexical) {
		return 0;
	}

	const repeatedPrefix = /^(re\s*:\s*){3,}/.test(metadata.subject?.toLowerCase() ?? '') ? 0.5 : 0;
	const repeatedTerms = /(fwd|forward|reminder)\b/.test(lexical) ? 0.3 : 0;
	const lowDiversity = metadata.participantsNormalized.length <= 1 ? 0.25 : 0;

	return clampScore(repeatedPrefix + repeatedTerms + lowDiversity);
}

function singleShotPenalty(metadata: ScanThreadMetadata): number {
	if (metadata.messageCount <= 1) {
		return 1;
	}

	return clampScore(1 - (metadata.messageCount - 1) / 4);
}

export function scoreCandidate(
	metadata: ScanThreadMetadata,
	options: HeuristicOptions = {}
): HeuristicSignalBundle {
	const weights = {
		...DEFAULT_HEURISTIC_WEIGHTS,
		...options.weights
	};
	const penaltyWeights = {
		...DEFAULT_HEURISTIC_PENALTY_WEIGHTS,
		...options.penaltyWeights
	};

	const messageDepth = clampScore((metadata.messageCount - 1) / 12);
	const participantDiversity = clampScore((metadata.participantsNormalized.length - 1) / 5);
	const continuity = continuityScore(metadata);
	const provenanceStrength = clampScore(metadata.retrieval.hitCount / 6);
	const actionabilityLexical = actionabilityLexicalScore(metadata);
	const resurfacing = resurfacingScore(metadata);
	const historicalPersistence = historicalPersistenceScore(metadata);
	const novelty = noveltyScore(metadata);
	const importanceMarkers = importanceMarkerScore(metadata);

	const bulkNoisePenaltyValue = bulkNoisePenalty(metadata);
	const receiptAutoMailPenaltyValue = receiptAutoMailPenalty(metadata);
	const redundancyPenaltyValue = redundancyPenalty(metadata);
	const singleShotPenaltyValue = singleShotPenalty(metadata);

	const positives =
		messageDepth * weights.messageDepth +
		participantDiversity * weights.participantDiversity +
		continuity * weights.continuity +
		provenanceStrength * weights.provenanceStrength +
		actionabilityLexical * weights.actionabilityLexical +
		resurfacing * weights.resurfacing +
		historicalPersistence * weights.historicalPersistence +
		novelty * weights.novelty +
		importanceMarkers * weights.importanceMarkers;

	const penalties =
		bulkNoisePenaltyValue * penaltyWeights.bulkNoisePenalty +
		receiptAutoMailPenaltyValue * penaltyWeights.receiptAutoMailPenalty +
		redundancyPenaltyValue * penaltyWeights.redundancyPenalty +
		singleShotPenaltyValue * penaltyWeights.singleShotPenalty;

	const nonNoiseStrength = clampScore(positives);
	const total = clampScore(nonNoiseStrength - penalties);

	return {
		messageDepth,
		participantDiversity,
		continuity,
		provenanceStrength,
		actionabilityLexical,
		resurfacing,
		historicalPersistence,
		novelty,
		importanceMarkers,
		bulkNoisePenalty: bulkNoisePenaltyValue,
		receiptAutoMailPenalty: receiptAutoMailPenaltyValue,
		redundancyPenalty: redundancyPenaltyValue,
		singleShotPenalty: singleShotPenaltyValue,
		nonNoiseStrength,
		total
	};
}

function compareCandidates(left: HeuristicCandidate, right: HeuristicCandidate): number {
	if (right.signals.total !== left.signals.total) {
		return right.signals.total - left.signals.total;
	}

	if (right.signals.provenanceStrength !== left.signals.provenanceStrength) {
		return right.signals.provenanceStrength - left.signals.provenanceStrength;
	}

	if (right.metadata.messageCount !== left.metadata.messageCount) {
		return right.metadata.messageCount - left.metadata.messageCount;
	}

	return left.metadata.threadId.localeCompare(right.metadata.threadId);
}

export function filterCandidates(
	metadata: ScanThreadMetadata[],
	options: HeuristicOptions = {}
): HeuristicFilterResult {
	const minTotalScore = options.minTotalScore ?? DEFAULT_HEURISTIC_THRESHOLDS.minTotalScore;
	const minMessageCount = options.minMessageCount ?? DEFAULT_HEURISTIC_THRESHOLDS.minMessageCount;

	const kept: HeuristicCandidate[] = [];
	const dropped: HeuristicCandidate[] = [];

	for (const item of metadata) {
		const signals = scoreCandidate(item, options);
		const normalized: HeuristicCandidate = {
			metadata: item,
			signals
		};

		if (item.messageCount < minMessageCount) {
			dropped.push({
				...normalized,
				dropReason: 'min_message_count'
			});
			continue;
		}

		if (signals.total < minTotalScore) {
			dropped.push({
				...normalized,
				dropReason: 'below_threshold'
			});
			continue;
		}

		kept.push(normalized);
	}

	kept.sort(compareCandidates);
	dropped.sort(compareCandidates);

	return { kept, dropped };
}
