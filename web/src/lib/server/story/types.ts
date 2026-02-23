import type { StoryLogger } from './logging';

export type StoryExplorationProfile = 'fast' | 'balanced' | 'deep';

export type StoryExplorationOptions = {
	profile?: StoryExplorationProfile;
	maxResearchSteps?: number;
	minRelatedThreads?: number;
	minParticipantHistories?: number;
	minConceptThreads?: number;
	hints?: {
		subject?: string;
		participants?: string[];
	};
};

export type StoryViewerContext = {
	subject: string;
	email: string | null;
	name: string | null;
	narration: 'second-person';
};

export type StoryRequest = {
	threadId: string;
	exploration?: StoryExplorationOptions;
};

export type StoryThreadProvenance = {
	source:
		| 'selected_thread'
		| 'search_related_threads'
		| 'participant_history'
		| 'search_threads_by_concept'
		| 'search_threads_by_time_window'
		| 'expand_participant_network';
	query: string | null;
};

export type StoryMessageExcerpt = {
	messageId: string;
	sentAt: string | null;
	from: string | null;
	to: string[];
	cc: string[];
	subject: string | null;
	excerpt: string | null;
};

export type StoryThreadResearch = {
	threadId: string;
	historyId: string | null;
	subject: string | null;
	participants: string[];
	messageCount: number;
	firstMessageAt: string | null;
	lastMessageAt: string | null;
	latestSnippet: string | null;
	messages: StoryMessageExcerpt[];
	provenance: StoryThreadProvenance[];
};

export type StoryParticipantHistory = {
	participant: string;
	threads: StoryThreadResearch[];
};

export type StoryResearchContext = {
	selectedThread: StoryThreadResearch;
	relatedThreads: StoryThreadResearch[];
	participantHistory: StoryParticipantHistory[];
	explorationSummary: {
		relatedThreadsDiscovered: number;
		participantHistoriesLoaded: number;
		conceptThreadsFound: number;
		timelineThreadsFound: number;
		participantNetworkThreadsFound: number;
		provenanceCounts: Record<string, number>;
	};
};

export type StoryPipelineMetadata = {
	threadId: string;
	model: string;
	format: 'markdown';
	research: {
		steps: number;
		relatedThreads: number;
		participantHistories: number;
	};
	exploration: {
		profile: StoryExplorationProfile;
		maxResearchSteps: number;
		minRelatedThreads: number;
		minParticipantHistories: number;
		minConceptThreads: number;
		relatedThreadsDiscovered: number;
		participantHistoriesLoaded: number;
		conceptThreadsFound: number;
		timelineThreadsFound: number;
		participantNetworkThreadsFound: number;
		totalThreadsInContext: number;
	};
};

export type StoryPipelineResult = {
	story: string;
	metadata: StoryPipelineMetadata;
};

export type StoryPipelineProgress = {
	label: string;
	stage: string;
	metadata?: Record<string, unknown>;
	timestamp: string;
};

export type StoryPipelineToken = {
	token: string;
	index: number;
	isFinal?: boolean;
	timestamp: string;
};

export type StoryPipelineOptions = {
	threadId: string;
	accessToken: string;
	exploration?: StoryExplorationOptions;
	viewerContext?: StoryViewerContext;
	fetchImpl?: typeof fetch;
	model?: string;
	logger?: StoryLogger;
	onProgress?: (progress: StoryPipelineProgress) => void;
	onToken?: (token: StoryPipelineToken) => void;
	streamWriterTokens?: boolean;
};
