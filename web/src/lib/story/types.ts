export type StoryStatusPayload = {
	label: string;
	stage: string;
	metadata?: Record<string, unknown>;
	timestamp: string;
};

export type StoryTokenPayload = {
	token: string;
	index: number;
	isFinal?: boolean;
	timestamp: string;
};

export type StoryClientEvent =
	| {
			event: 'story.started';
			data: {
				startedAt: string;
			};
	  }
	| {
			event: 'story.status';
			data: StoryStatusPayload;
	  }
	| {
			event: 'story.token';
			data: StoryTokenPayload;
	  }
	| {
			event: 'story.complete';
			data: {
				completedAt: string;
				story: string;
				metadata: {
					threadId: string;
					model: string;
					format?: 'markdown';
					research: {
						steps: number;
						relatedThreads: number;
						participantHistories: number;
					};
					exploration?: {
						profile: 'fast' | 'balanced' | 'deep';
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
			};
	  }
	| {
			event: 'story.error';
			data: {
				code: string;
			};
	  }
	| {
			event: 'story.keepalive';
			data: {
				timestamp: string;
			};
	  };
