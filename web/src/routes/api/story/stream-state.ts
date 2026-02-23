export type StoryStreamState = {
	nextEventId: () => string;
	incrementStatusCount: () => void;
	incrementTokenCount: () => void;
	snapshot: () => {
		statusEventCount: number;
		tokenEventCount: number;
	};
};

export function createStoryStreamState(): StoryStreamState {
	let eventCounter = 0;
	let statusEventCount = 0;
	let tokenEventCount = 0;

	return {
		nextEventId: () => {
			eventCounter += 1;
			return String(eventCounter);
		},
		incrementStatusCount: () => {
			statusEventCount += 1;
		},
		incrementTokenCount: () => {
			tokenEventCount += 1;
		},
		snapshot: () => ({
			statusEventCount,
			tokenEventCount
		})
	};
}
