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
					research: {
						steps: number;
						relatedThreads: number;
						participantHistories: number;
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
