import type { StoryPipelineMetadata } from '$lib/server/story/types';
import type { StoryStatusPayload, StoryTokenPayload } from '$lib/story/types';

export type StorySseEvent =
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
				metadata: StoryPipelineMetadata;
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

export function toSseEvent(event: StorySseEvent, id?: string): string {
	const lines = [];

	if (id) {
		lines.push(`id: ${id}`);
	}

	lines.push(`event: ${event.event}`);
	lines.push(`data: ${JSON.stringify(event.data)}`);

	return `${lines.join('\n')}\n\n`;
}
