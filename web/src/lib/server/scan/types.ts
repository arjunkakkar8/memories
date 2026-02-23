export type ScanThreadMetadata = {
	threadId: string;
	historyId: string | null;
	subject: string | null;
	participants: string[];
	participantsNormalized: string[];
	senderAddresses: string[];
	senderDomains: string[];
	labelIds: string[];
	importanceMarkers: {
		important: boolean;
		starred: boolean;
		hasUserLabels: boolean;
	};
	subjectLexical: string;
	snippetLexical: string;
	messageCount: number;
	firstMessageAt: string | null;
	lastMessageAt: string | null;
	latestSnippet: string | null;
	retrieval: ScanThreadRetrievalProvenance;
};

export type ScanSampledWindow = {
	id: string;
	startEpochSec: number;
	endEpochSec: number;
	durationDays: number;
};

export type ScanRetrievalHit = {
	packId: string;
	packName: string;
	window: ScanSampledWindow;
	query: string;
	labelIds: string[];
	hitCount: number;
};

export type ScanThreadRetrievalProvenance = {
	hitCount: number;
	packIds: string[];
	windowIds: string[];
	hits: ScanRetrievalHit[];
};

export type HeuristicSignalBundle = {
	messageDepth: number;
	participantDiversity: number;
	continuity: number;
	provenanceStrength: number;
	actionabilityLexical: number;
	resurfacing: number;
	historicalPersistence: number;
	novelty: number;
	importanceMarkers: number;
	bulkNoisePenalty: number;
	receiptAutoMailPenalty: number;
	redundancyPenalty: number;
	singleShotPenalty: number;
	nonNoiseStrength: number;
	total: number;
};

export type HeuristicCandidate = {
	metadata: ScanThreadMetadata;
	signals: HeuristicSignalBundle;
	dropReason?: 'below_threshold' | 'min_message_count';
};

export type HeuristicFilterResult = {
	kept: HeuristicCandidate[];
	dropped: HeuristicCandidate[];
};

export type LlmCandidateScore = {
	threadId: string;
	score: number;
	rationale: string;
	themes: string[];
	title: string | null;
};

export type RankedScanCandidate = {
	threadId: string;
	displayTitle: string | null;
	metadata: ScanThreadMetadata;
	signals: HeuristicSignalBundle;
	llm: LlmCandidateScore;
	combinedScore: number;
	rank: number;
};

export type ScanPipelineProgress = {
	stage: 'fetch' | 'heuristics' | 'llm' | 'complete';
	processed: number;
	total: number;
	message: string;
};

export type ScanStreamEvent =
	| {
			type: 'scan:start';
			payload: {
				startedAt: string;
			};
	  }
	| {
			type: 'scan:progress';
			payload: ScanPipelineProgress;
	  }
	| {
			type: 'scan:candidates';
			payload: {
				batchIndex: number;
				candidates: RankedScanCandidate[];
			};
	  }
	| {
			type: 'scan:error';
			payload: {
				code: string;
				message: string;
			};
	  }
	| {
			type: 'scan:complete';
			payload: {
				completedAt: string;
				totalCandidates: number;
			};
	  };

export type ScanPipelineResult = {
	rankedCandidates: RankedScanCandidate[];
	progress: ScanPipelineProgress[];
};
