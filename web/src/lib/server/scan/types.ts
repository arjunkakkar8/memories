export type ScanThreadMetadata = {
	threadId: string;
	historyId: string | null;
	subject: string | null;
	participants: string[];
	messageCount: number;
	firstMessageAt: string | null;
	lastMessageAt: string | null;
	latestSnippet: string | null;
};

export type HeuristicSignalBundle = {
	messageDepth: number;
	participantDiversity: number;
	recency: number;
	continuity: number;
	total: number;
};

export type HeuristicCandidate = {
	metadata: ScanThreadMetadata;
	signals: HeuristicSignalBundle;
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
};

export type RankedScanCandidate = {
	threadId: string;
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
