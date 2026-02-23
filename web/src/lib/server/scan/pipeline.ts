import { createQuotaBudget, type QuotaBudget } from './quota-budget';
import { fetchGmailThreadMetadata } from './gmail-source';
import { filterCandidates } from './heuristics';
import { scoreCandidateBatch } from './llm-score';
import { createScanRuntimeConfig, type ScanRuntimeConfig } from './config';
import {
	createCustomQueryPack,
	materializeGmailQuery,
	resolveQueryPacks,
	type ScanQueryPack
} from './query-packs';
import { sampleRandomWindows } from './window-sampler';
import type {
	HeuristicCandidate,
	LlmCandidateScore,
	RankedScanCandidate,
	ScanRetrievalHit,
	ScanSampledWindow,
	ScanThreadMetadata,
	ScanPipelineProgress,
	ScanPipelineResult
} from './types';

type RunScanPipelineOptions = {
	accessToken: string;
	budget?: QuotaBudget;
	fetchImpl?: typeof fetch;
	openRouterFetchImpl?: typeof fetch;
	openRouterApiKey?: string;
	openRouterModel?: string;
	query?: string;
	pageSize?: number;
	maxPages?: number;
	maxThreads?: number;
	llmBatchSize?: number;
	runtimeConfig?: Partial<ScanRuntimeConfig>;
	onProgress?: (entry: ScanPipelineProgress) => void;
	onCandidateBatch?: (entry: { batchIndex: number; candidates: RankedScanCandidate[] }) => void;
};

function toFallbackLlmScore(candidate: HeuristicCandidate): LlmCandidateScore {
	return {
		threadId: candidate.metadata.threadId,
		score: candidate.signals.total,
		rationale: 'Fallback to heuristic-only score',
		themes: [],
		title: null
	};
}

function compareCandidates(left: HeuristicCandidate, right: HeuristicCandidate): number {
	if (right.signals.total !== left.signals.total) {
		return right.signals.total - left.signals.total;
	}

	if (right.signals.nonNoiseStrength !== left.signals.nonNoiseStrength) {
		return right.signals.nonNoiseStrength - left.signals.nonNoiseStrength;
	}

	if (right.metadata.messageCount !== left.metadata.messageCount) {
		return right.metadata.messageCount - left.metadata.messageCount;
	}

	return left.metadata.threadId.localeCompare(right.metadata.threadId);
}

function toSubjectRoot(subject: string | null): string {
	if (!subject) {
		return 'none';
	}

	return (
		subject
			.toLowerCase()
			.replace(/^(re\s*:|fwd\s*:|fw\s*:)+/g, '')
			.replace(/\[[^\]]+\]/g, '')
			.replace(/[^a-z0-9\s]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim() || 'none'
	);
}

function choosePrimaryDomain(metadata: ScanThreadMetadata): string {
	return metadata.senderDomains[0] ?? 'unknown';
}

function applyDiversity(
	candidates: HeuristicCandidate[],
	options: {
		maxPerSenderDomain: number;
		maxPerSubjectRoot: number;
	}
): HeuristicCandidate[] {
	const byDomain = new Map<string, number>();
	const bySubjectRoot = new Map<string, number>();
	const kept: HeuristicCandidate[] = [];

	for (const candidate of candidates) {
		const domain = choosePrimaryDomain(candidate.metadata);
		const subjectRoot = toSubjectRoot(candidate.metadata.subject);
		const domainCount = byDomain.get(domain) ?? 0;
		const subjectCount = bySubjectRoot.get(subjectRoot) ?? 0;

		if (domainCount >= options.maxPerSenderDomain || subjectCount >= options.maxPerSubjectRoot) {
			continue;
		}

		kept.push(candidate);
		byDomain.set(domain, domainCount + 1);
		bySubjectRoot.set(subjectRoot, subjectCount + 1);
	}

	return kept;
}

function appendUniqueCandidates(
	base: HeuristicCandidate[],
	incoming: HeuristicCandidate[],
	minimumCount: number
): HeuristicCandidate[] {
	const seen = new Set(base.map((candidate) => candidate.metadata.threadId));
	const next = [...base];

	for (const candidate of incoming) {
		if (next.length >= minimumCount) {
			break;
		}

		if (seen.has(candidate.metadata.threadId)) {
			continue;
		}

		next.push(candidate);
		seen.add(candidate.metadata.threadId);
	}

	return next;
}

function toRankedCandidates(
	candidates: HeuristicCandidate[],
	llmScores: LlmCandidateScore[]
): RankedScanCandidate[] {
	const scoreByThreadId = new Map(llmScores.map((entry) => [entry.threadId, entry]));

	const merged = candidates.map((candidate) => {
		const llmScore =
			scoreByThreadId.get(candidate.metadata.threadId) ?? toFallbackLlmScore(candidate);

		return {
			threadId: candidate.metadata.threadId,
			displayTitle: llmScore.title,
			metadata: candidate.metadata,
			signals: candidate.signals,
			llm: llmScore,
			combinedScore: candidate.signals.total * 0.7 + llmScore.score * 0.3,
			rank: 0
		} satisfies RankedScanCandidate;
	});

	merged.sort((left, right) => {
		if (right.combinedScore !== left.combinedScore) {
			return right.combinedScore - left.combinedScore;
		}

		return left.threadId.localeCompare(right.threadId);
	});

	for (let index = 0; index < merged.length; index += 1) {
		merged[index].rank = index + 1;
	}

	return merged;
}

function minDate(left: string | null, right: string | null): string | null {
	if (!left) {
		return right;
	}
	if (!right) {
		return left;
	}

	return new Date(left).getTime() <= new Date(right).getTime() ? left : right;
}

function maxDate(left: string | null, right: string | null): string | null {
	if (!left) {
		return right;
	}
	if (!right) {
		return left;
	}

	return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}

function mergeMetadata(
	existing: ScanThreadMetadata | undefined,
	incoming: ScanThreadMetadata,
	hit: ScanRetrievalHit
): ScanThreadMetadata {
	if (!existing) {
		return {
			...incoming,
			retrieval: {
				hitCount: hit.hitCount,
				packIds: [hit.packId],
				windowIds: [hit.window.id],
				hits: [hit]
			}
		};
	}

	const hitsByPackWindow = new Map(
		existing.retrieval.hits.map((entry) => [`${entry.packId}:${entry.window.id}`, entry])
	);
	const hitKey = `${hit.packId}:${hit.window.id}`;
	hitsByPackWindow.set(hitKey, {
		...(hitsByPackWindow.get(hitKey) ?? hit),
		hitCount: (hitsByPackWindow.get(hitKey)?.hitCount ?? 0) + hit.hitCount
	});

	const mergedHits = [...hitsByPackWindow.values()];

	return {
		...existing,
		historyId: existing.historyId ?? incoming.historyId,
		subject: existing.subject ?? incoming.subject,
		participants: [...new Set([...existing.participants, ...incoming.participants])],
		participantsNormalized: [
			...new Set([...existing.participantsNormalized, ...incoming.participantsNormalized])
		],
		senderAddresses: [...new Set([...existing.senderAddresses, ...incoming.senderAddresses])],
		senderDomains: [...new Set([...existing.senderDomains, ...incoming.senderDomains])],
		labelIds: [...new Set([...existing.labelIds, ...incoming.labelIds])],
		importanceMarkers: {
			important: existing.importanceMarkers.important || incoming.importanceMarkers.important,
			starred: existing.importanceMarkers.starred || incoming.importanceMarkers.starred,
			hasUserLabels:
				existing.importanceMarkers.hasUserLabels || incoming.importanceMarkers.hasUserLabels
		},
		subjectLexical: existing.subjectLexical || incoming.subjectLexical,
		snippetLexical:
			existing.snippetLexical.length >= incoming.snippetLexical.length
				? existing.snippetLexical
				: incoming.snippetLexical,
		messageCount: Math.max(existing.messageCount, incoming.messageCount),
		firstMessageAt: minDate(existing.firstMessageAt, incoming.firstMessageAt),
		lastMessageAt: maxDate(existing.lastMessageAt, incoming.lastMessageAt),
		latestSnippet:
			(existing.latestSnippet?.length ?? 0) >= (incoming.latestSnippet?.length ?? 0)
				? existing.latestSnippet
				: incoming.latestSnippet,
		retrieval: {
			hitCount: mergedHits.reduce((sum, entry) => sum + entry.hitCount, 0),
			packIds: [...new Set(mergedHits.map((entry) => entry.packId))],
			windowIds: [...new Set(mergedHits.map((entry) => entry.window.id))],
			hits: mergedHits
		}
	};
}

function buildRetrievalJobs(
	packs: ScanQueryPack[],
	windows: ScanSampledWindow[]
): Array<{ pack: ScanQueryPack; window: ScanSampledWindow; query: string }> {
	const jobs: Array<{ pack: ScanQueryPack; window: ScanSampledWindow; query: string }> = [];

	for (const pack of packs) {
		for (const window of windows) {
			jobs.push({
				pack,
				window,
				query: materializeGmailQuery(pack, window)
			});
		}
	}

	return jobs;
}

function logCandidateScoreBreakdowns(candidates: HeuristicCandidate[]): void {
	const sorted = [...candidates].sort(compareCandidates);

	console.info(`[scan] Candidate score breakdowns (${sorted.length} total)`);
	for (const candidate of sorted) {
		const { metadata, signals } = candidate;
		console.info(
			`[scan] ${metadata.threadId} total=${signals.total.toFixed(3)} nonNoise=${signals.nonNoiseStrength.toFixed(3)} ` +
				`depth=${signals.messageDepth.toFixed(3)} diversity=${signals.participantDiversity.toFixed(3)} continuity=${signals.continuity.toFixed(3)} ` +
				`provenance=${signals.provenanceStrength.toFixed(3)} actionability=${signals.actionabilityLexical.toFixed(3)} resurfacing=${signals.resurfacing.toFixed(3)} ` +
				`persistence=${signals.historicalPersistence.toFixed(3)} novelty=${signals.novelty.toFixed(3)} importance=${signals.importanceMarkers.toFixed(3)} ` +
				`penalties={bulk:${signals.bulkNoisePenalty.toFixed(3)},receipt:${signals.receiptAutoMailPenalty.toFixed(3)},redundancy:${signals.redundancyPenalty.toFixed(3)},singleShot:${signals.singleShotPenalty.toFixed(3)}} ` +
				`subject=${JSON.stringify(metadata.subject ?? '')}`
		);
	}
}

export async function runScanPipeline(
	options: RunScanPipelineOptions
): Promise<ScanPipelineResult> {
	const {
		accessToken,
		query,
		pageSize,
		maxPages,
		maxThreads,
		fetchImpl = fetch,
		openRouterFetchImpl = fetch,
		openRouterApiKey,
		openRouterModel,
		onProgress,
		onCandidateBatch
	} = options;

	const budget = options.budget ?? createQuotaBudget();
	const runtimeConfig = createScanRuntimeConfig(options.runtimeConfig);
	const progress: ScanPipelineProgress[] = [];

	const emit = (entry: ScanPipelineProgress): void => {
		progress.push(entry);
		onProgress?.(entry);
	};

	const packs = query
		? [createCustomQueryPack(query)]
		: resolveQueryPacks(runtimeConfig.queryPacks.ids);
	const windows = sampleRandomWindows({
		count: runtimeConfig.randomWindows.count,
		durationDaysOptions: runtimeConfig.randomWindows.durationDaysOptions,
		maxLookbackDays: runtimeConfig.randomWindows.maxLookbackDays,
		maxOverlapRatio: runtimeConfig.randomWindows.maxOverlapRatio
	});

	const jobs = buildRetrievalJobs(packs, windows);
	console.info(
		`[scan] Retrieval plan uses ${packs.length} pack(s), ${windows.length} window(s), ${jobs.length} total job(s)`
	);
	const mergedMetadataById = new Map<string, ScanThreadMetadata>();

	for (let index = 0; index < jobs.length; index += 1) {
		const job = jobs[index];
		emit({
			stage: 'fetch',
			processed: index,
			total: jobs.length,
			message: `Retrieving pack ${job.pack.id} (${index + 1}/${jobs.length}) for ${job.window.durationDays}d window`
		});

		const metadata = await fetchGmailThreadMetadata({
			accessToken,
			budget,
			fetchImpl,
			query: job.query,
			labelIds: job.pack.labelIds,
			pageSize: pageSize ?? runtimeConfig.queryPacks.defaultFetchBudget.pageSize,
			maxPages: maxPages ?? runtimeConfig.queryPacks.defaultFetchBudget.maxPages,
			maxThreads: maxThreads ?? runtimeConfig.queryPacks.defaultFetchBudget.maxThreads
		});

		for (const thread of metadata) {
			const hit: ScanRetrievalHit = {
				packId: job.pack.id,
				packName: job.pack.name,
				window: job.window,
				query: job.query,
				labelIds: job.pack.labelIds ?? [],
				hitCount: 1
			};

			mergedMetadataById.set(
				thread.threadId,
				mergeMetadata(mergedMetadataById.get(thread.threadId), thread, hit)
			);
		}
	}

	const metadata = [...mergedMetadataById.values()];

	emit({
		stage: 'fetch',
		processed: jobs.length,
		total: jobs.length,
		message: `Fetched metadata for ${metadata.length} unique thread(s) across ${jobs.length} retrieval job(s)`
	});

	const filtered = filterCandidates(metadata, {
		minTotalScore: runtimeConfig.heuristics.thresholds.minTotalScore,
		minMessageCount: runtimeConfig.heuristics.thresholds.minMessageCount,
		weights: runtimeConfig.heuristics.weights,
		penaltyWeights: runtimeConfig.heuristics.penaltyWeights
	});

	logCandidateScoreBreakdowns([...filtered.kept, ...filtered.dropped]);

	emit({
		stage: 'heuristics',
		processed: filtered.kept.length,
		total: metadata.length,
		message: `Heuristic filter kept ${filtered.kept.length} of ${metadata.length} thread(s)`
	});

	const diverseKept = applyDiversity(filtered.kept, runtimeConfig.diversity).sort(
		compareCandidates
	);
	let selected = [...diverseKept];

	if (selected.length < runtimeConfig.minimumReturnedCandidates) {
		const thresholdPool = filtered.dropped
			.filter((candidate) => candidate.dropReason === 'below_threshold')
			.sort(compareCandidates);
		const deepFallbackPool = filtered.dropped
			.filter((candidate) => candidate.dropReason !== 'below_threshold')
			.sort((left, right) => {
				if (right.signals.nonNoiseStrength !== left.signals.nonNoiseStrength) {
					return right.signals.nonNoiseStrength - left.signals.nonNoiseStrength;
				}

				return compareCandidates(left, right);
			});

		selected = appendUniqueCandidates(
			selected,
			thresholdPool,
			runtimeConfig.minimumReturnedCandidates
		);
		selected = appendUniqueCandidates(
			selected,
			deepFallbackPool,
			runtimeConfig.minimumReturnedCandidates
		);

		emit({
			stage: 'heuristics',
			processed: selected.length,
			total: runtimeConfig.minimumReturnedCandidates,
			message: `Fallback fill used to reach ${selected.length} candidate(s)`
		});
	}

	selected.sort(compareCandidates);

	if (selected.length === 0) {
		emit({
			stage: 'llm',
			processed: 0,
			total: 0,
			message: 'LLM reranking skipped because no candidates are available'
		});

		emit({
			stage: 'complete',
			processed: 0,
			total: 0,
			message: 'Scan complete with no candidates'
		});

		return {
			rankedCandidates: [],
			progress
		};
	}

	const llmScores: LlmCandidateScore[] = [];
	const shouldUseLlm = Boolean(openRouterApiKey);

	if (shouldUseLlm) {
		const batchScores = await scoreCandidateBatch(selected, {
			budget,
			fetchImpl: openRouterFetchImpl,
			apiKey: openRouterApiKey,
			model: openRouterModel
		});

		llmScores.push(...batchScores);
		onCandidateBatch?.({
			batchIndex: 0,
			candidates: toRankedCandidates(selected, batchScores)
		});

		emit({
			stage: 'llm',
			processed: selected.length,
			total: selected.length,
			message: `Scored and titled ${selected.length} of ${selected.length} candidate(s)`
		});
	} else {
		emit({
			stage: 'llm',
			processed: selected.length,
			total: selected.length,
			message: 'LLM reranking skipped; heuristic ranking only'
		});
	}

	const rankedCandidates = toRankedCandidates(selected, llmScores);
	emit({
		stage: 'complete',
		processed: rankedCandidates.length,
		total: rankedCandidates.length,
		message: `Scan complete with ${rankedCandidates.length} ranked candidate(s)`
	});

	return {
		rankedCandidates,
		progress
	};
}
