import type { ScanClientEvent } from './candidate-store';

type ScanRequestBody = {
	query?: string;
	pageSize?: number;
	maxPages?: number;
	maxThreads?: number;
	llmBatchSize?: number;
};

type ScanStreamOptions = {
	body?: ScanRequestBody;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
	onEvent: (event: ScanClientEvent) => void;
};

export type ScanStreamHandle = {
	stop: () => void;
	done: Promise<void>;
};

function parseEventChunk(chunk: string): ScanClientEvent | null {
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
			case 'scan.started':
			case 'scan.progress':
			case 'scan.candidates':
			case 'scan.complete':
			case 'scan.error':
			case 'scan.keepalive':
				return {
					event: eventName,
					data
				} as ScanClientEvent;
			default:
				return null;
		}
	} catch {
		return null;
	}
}

async function consumeSse(
	response: Response,
	onEvent: (event: ScanClientEvent) => void
): Promise<void> {
	if (!response.body) {
		throw new Error('scan_stream_unavailable');
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

export function startScanStream(options: ScanStreamOptions): ScanStreamHandle {
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
		const response = await fetchImpl('/api/scan', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'text/event-stream'
			},
			body: JSON.stringify(options.body ?? {}),
			signal: controller.signal
		});

		if (!response.ok) {
			let message = `scan_request_failed:${response.status}`;

			try {
				const payload = (await response.json()) as { error?: string };
				if (payload.error) {
					message = payload.error;
				}
			} catch {
				// Keep fallback message.
			}

			throw new Error(message);
		}

		await consumeSse(response, options.onEvent);
	})();

	return {
		stop: () => controller.abort('scan_stopped'),
		done
	};
}
