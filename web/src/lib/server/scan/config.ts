export const MIN_RETURNED_CANDIDATES = 5;

export const DEFAULT_RANDOM_WINDOW_COUNT = 10;
export const DEFAULT_RANDOM_WINDOW_DURATIONS_DAYS = [180] as const;
export const DEFAULT_WINDOW_MAX_LOOKBACK_DAYS = 365 * 20;
export const DEFAULT_WINDOW_MAX_OVERLAP_RATIO = 0.4;

export const DEFAULT_QUERY_PACK_IDS = ['inbox-focus', 'starred-important', 'sent-replies'] as const;

export const DEFAULT_QUERY_PACK_FETCH_BUDGET = {
	pageSize: 100,
	maxPages: 1,
	maxThreads: 40
} as const;

export const DEFAULT_HEURISTIC_WEIGHTS = {
	messageDepth: 0.16,
	participantDiversity: 0.09,
	continuity: 0.15,
	provenanceStrength: 0.16,
	actionabilityLexical: 0.13,
	resurfacing: 0.11,
	historicalPersistence: 0.12,
	novelty: 0.04,
	importanceMarkers: 0.04
} as const;

export type HeuristicWeights = {
	[K in keyof typeof DEFAULT_HEURISTIC_WEIGHTS]: number;
};

export const DEFAULT_HEURISTIC_PENALTY_WEIGHTS = {
	bulkNoisePenalty: 0.35,
	receiptAutoMailPenalty: 0.28,
	redundancyPenalty: 0.22,
	singleShotPenalty: 0.15
} as const;

export type HeuristicPenaltyWeights = {
	[K in keyof typeof DEFAULT_HEURISTIC_PENALTY_WEIGHTS]: number;
};

export const DEFAULT_HEURISTIC_THRESHOLDS = {
	minTotalScore: 0.38,
	minMessageCount: 1
} as const;

export const DEFAULT_DIVERSITY_CAPS = {
	maxPerSenderDomain: 2,
	maxPerSubjectRoot: 1
} as const;

export type ScanRuntimeConfig = {
	minimumReturnedCandidates: number;
	randomWindows: {
		count: number;
		durationDaysOptions: number[];
		maxLookbackDays: number;
		maxOverlapRatio: number;
	};
	queryPacks: {
		ids: string[];
		defaultFetchBudget: {
			pageSize: number;
			maxPages: number;
			maxThreads: number;
		};
	};
	heuristics: {
		weights: HeuristicWeights;
		penaltyWeights: HeuristicPenaltyWeights;
		thresholds: {
			minTotalScore: number;
			minMessageCount: number;
		};
	};
	diversity: {
		maxPerSenderDomain: number;
		maxPerSubjectRoot: number;
	};
};

export function createScanRuntimeConfig(
	overrides: Partial<ScanRuntimeConfig> = {}
): ScanRuntimeConfig {
	return {
		minimumReturnedCandidates: overrides.minimumReturnedCandidates ?? MIN_RETURNED_CANDIDATES,
		randomWindows: {
			count: overrides.randomWindows?.count ?? DEFAULT_RANDOM_WINDOW_COUNT,
			durationDaysOptions: overrides.randomWindows?.durationDaysOptions?.length
				? overrides.randomWindows.durationDaysOptions
				: [...DEFAULT_RANDOM_WINDOW_DURATIONS_DAYS],
			maxLookbackDays: overrides.randomWindows?.maxLookbackDays ?? DEFAULT_WINDOW_MAX_LOOKBACK_DAYS,
			maxOverlapRatio: overrides.randomWindows?.maxOverlapRatio ?? DEFAULT_WINDOW_MAX_OVERLAP_RATIO
		},
		queryPacks: {
			ids: overrides.queryPacks?.ids?.length
				? overrides.queryPacks.ids
				: [...DEFAULT_QUERY_PACK_IDS],
			defaultFetchBudget: {
				pageSize:
					overrides.queryPacks?.defaultFetchBudget?.pageSize ??
					DEFAULT_QUERY_PACK_FETCH_BUDGET.pageSize,
				maxPages:
					overrides.queryPacks?.defaultFetchBudget?.maxPages ??
					DEFAULT_QUERY_PACK_FETCH_BUDGET.maxPages,
				maxThreads:
					overrides.queryPacks?.defaultFetchBudget?.maxThreads ??
					DEFAULT_QUERY_PACK_FETCH_BUDGET.maxThreads
			}
		},
		heuristics: {
			weights: {
				...DEFAULT_HEURISTIC_WEIGHTS,
				...overrides.heuristics?.weights
			},
			penaltyWeights: {
				...DEFAULT_HEURISTIC_PENALTY_WEIGHTS,
				...overrides.heuristics?.penaltyWeights
			},
			thresholds: {
				...DEFAULT_HEURISTIC_THRESHOLDS,
				...overrides.heuristics?.thresholds
			}
		},
		diversity: {
			maxPerSenderDomain:
				overrides.diversity?.maxPerSenderDomain ?? DEFAULT_DIVERSITY_CAPS.maxPerSenderDomain,
			maxPerSubjectRoot:
				overrides.diversity?.maxPerSubjectRoot ?? DEFAULT_DIVERSITY_CAPS.maxPerSubjectRoot
		}
	};
}
