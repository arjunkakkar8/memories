import type { StoryClientEvent } from './types';

type StoryStreamOptions = {
	threadId: string;
	exploration?: {
		profile?: 'fast' | 'balanced' | 'deep';
		maxResearchSteps?: number;
		minRelatedThreads?: number;
		minParticipantHistories?: number;
		minConceptThreads?: number;
		hints?: {
			subject?: string;
			participants?: string[];
		};
	};
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
	onEvent: (event: StoryClientEvent) => void;
};

export type StoryStreamHandle = {
	stop: () => void;
	done: Promise<void>;
};

function parseEventChunk(chunk: string): StoryClientEvent | null {
	const lines = chunk
		.split('\n')
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0 && !line.startsWith(':'));

	let eventName = '';
	let dataPayload = '';

	for (const line of lines) {
		if (line.startsWith('event:')) {
			eventName = line.slice('event:'.length).trim();
		}

		if (line.startsWith('data:')) {
			dataPayload = line.slice('data:'.length).trim();
		}
	}

	if (!eventName || !dataPayload) {
		return null;
	}

	try {
		const data = JSON.parse(dataPayload) as unknown;

		switch (eventName) {
			case 'story.started':
			case 'story.status':
			case 'story.token':
			case 'story.complete':
			case 'story.error':
			case 'story.keepalive':
				return {
					event: eventName,
					data
				} as StoryClientEvent;
			default:
				return null;
		}
	} catch {
		return null;
	}
}

async function consumeSse(
	response: Response,
	onEvent: (event: StoryClientEvent) => void
): Promise<void> {
	if (!response.body) {
		throw new Error('story_stream_unavailable');
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}

		buffer += decoder.decode(value, { stream: true });

		const parts = buffer.split('\n\n');
		buffer = parts.pop() ?? '';

		for (const part of parts) {
			const event = parseEventChunk(part);
			if (event) {
				onEvent(event);
			}
		}
	}

	if (buffer.trim().length > 0) {
		const event = parseEventChunk(buffer);
		if (event) {
			onEvent(event);
		}
	}
}

export function startStoryStream(options: StoryStreamOptions): StoryStreamHandle {
	const controller = new AbortController();

	if (options.signal) {
		if (options.signal.aborted) {
			controller.abort(options.signal.reason);
		} else {
			options.signal.addEventListener('abort', () => controller.abort(options.signal?.reason), {
				once: true
			});
		}
	}

	const fetchImpl = options.fetchImpl ?? fetch;

	const done = (async () => {
		const response = await fetchImpl('/api/story', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'text/event-stream'
			},
			body: JSON.stringify({ threadId: options.threadId, exploration: options.exploration }),
			signal: controller.signal
		});

		if (!response.ok) {
			let code = `story_request_failed:${response.status}`;

			try {
				const payload = (await response.json()) as { error?: { code?: string } };
				if (payload.error?.code) {
					code = payload.error.code;
				}
			} catch {
				// Keep fallback code.
			}

			throw new Error(code);
		}

		await consumeSse(response, options.onEvent);
	})();

	return {
		stop: () => controller.abort('story_stream_stopped'),
		done
	};
}
