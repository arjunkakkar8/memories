export type StoryRequest = {
	threadId: string;
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
};

export type StoryParticipantHistory = {
	participant: string;
	threads: StoryThreadResearch[];
};

export type StoryResearchContext = {
	selectedThread: StoryThreadResearch;
	relatedThreads: StoryThreadResearch[];
	participantHistory: StoryParticipantHistory[];
};

export type StoryPipelineMetadata = {
	threadId: string;
	model: string;
	research: {
		steps: number;
		relatedThreads: number;
		participantHistories: number;
	};
};

export type StoryPipelineResult = {
	story: string;
	metadata: StoryPipelineMetadata;
};

export type StoryPipelineOptions = {
	threadId: string;
	accessToken: string;
	fetchImpl?: typeof fetch;
	model?: string;
};
