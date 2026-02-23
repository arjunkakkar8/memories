import { createHash, randomUUID } from 'node:crypto';

type StoryLogLevel = 'info' | 'warn' | 'error';

type StoryLoggerContext = {
	requestId: string;
	sessionRef: string | null;
	threadRef: string | null;
	model: string | null;
};

type StoryLogDetails = Record<string, unknown>;

type StoryErrorDetails = {
	name: string;
	message: string;
	status: number | null;
	retryable: boolean;
};

function toSessionRef(sessionId: string | null | undefined): string | null {
	if (!sessionId) {
		return null;
	}

	return createHash('sha256').update(sessionId).digest('hex').slice(0, 12);
}

function toThreadRef(threadId: string | null | undefined): string | null {
	if (!threadId) {
		return null;
	}

	const normalized = threadId.trim();
	if (!normalized) {
		return null;
	}

	if (normalized.length <= 10) {
		return normalized;
	}

	return `${normalized.slice(0, 5)}...${normalized.slice(-5)}`;
}

function parseStatusFromMessage(message: string): number | null {
	const match = message.match(/:(\d{3})(?:$|\D)/);
	if (!match) {
		return null;
	}

	const status = Number(match[1]);
	return Number.isFinite(status) ? status : null;
}

export function parseStatusCode(error: unknown): number | null {
	if (!(error instanceof Error)) {
		return null;
	}

	const fromStatusCode = (error as { statusCode?: unknown }).statusCode;
	if (typeof fromStatusCode === 'number' && Number.isFinite(fromStatusCode)) {
		return fromStatusCode;
	}

	const fromStatus = (error as { status?: unknown }).status;
	if (typeof fromStatus === 'number' && Number.isFinite(fromStatus)) {
		return fromStatus;
	}

	const cause = (error as { cause?: unknown }).cause;
	if (cause && typeof cause === 'object') {
		const causeStatus = (cause as { status?: unknown; statusCode?: unknown }).status;
		if (typeof causeStatus === 'number' && Number.isFinite(causeStatus)) {
			return causeStatus;
		}

		const causeStatusCode = (cause as { statusCode?: unknown }).statusCode;
		if (typeof causeStatusCode === 'number' && Number.isFinite(causeStatusCode)) {
			return causeStatusCode;
		}
	}

	return parseStatusFromMessage(error.message);
}

export function isRetryableProviderStatus(status: number | null): boolean {
	if (status === null) {
		return false;
	}

	return status === 408 || status === 409 || status === 429 || status >= 500;
}

export function describeStoryError(error: unknown): StoryErrorDetails {
	if (!(error instanceof Error)) {
		return {
			name: 'UnknownError',
			message: 'non_error_thrown',
			status: null,
			retryable: false
		};
	}

	const status = parseStatusCode(error);
	const retryable =
		isRetryableProviderStatus(status) ||
		error.message.includes('timeout') ||
		error.message.includes('ECONNRESET') ||
		error.message.includes('ENOTFOUND');

	return {
		name: error.name,
		message: error.message,
		status,
		retryable
	};
}

function emit(
	level: StoryLogLevel,
	context: StoryLoggerContext,
	event: string,
	details: StoryLogDetails
): void {
	const payload = {
		ts: new Date().toISOString(),
		level,
		event,
		requestId: context.requestId,
		sessionRef: context.sessionRef,
		threadRef: context.threadRef,
		model: context.model,
		...details
	};

	const serialized = JSON.stringify(payload);
	if (level === 'error') {
		console.error(serialized);
		return;
	}

	if (level === 'warn') {
		console.warn(serialized);
		return;
	}

	console.info(serialized);
}

export type StoryLogger = {
	requestId: string;
	withContext: (context: { threadId?: string | null; model?: string | null }) => StoryLogger;
	info: (event: string, details?: StoryLogDetails) => void;
	warn: (event: string, details?: StoryLogDetails) => void;
	error: (event: string, details?: StoryLogDetails) => void;
	trackError: (event: string, error: unknown, details?: StoryLogDetails) => void;
};

function createLogger(context: StoryLoggerContext): StoryLogger {
	const write = (level: StoryLogLevel, event: string, details: StoryLogDetails = {}): void => {
		emit(level, context, event, details);
	};

	return {
		requestId: context.requestId,
		withContext(next) {
			return createLogger({
				...context,
				threadRef: next.threadId ? toThreadRef(next.threadId) : context.threadRef,
				model: next.model ?? context.model
			});
		},
		info(event, details = {}) {
			write('info', event, details);
		},
		warn(event, details = {}) {
			write('warn', event, details);
		},
		error(event, details = {}) {
			write('error', event, details);
		},
		trackError(event, error, details = {}) {
			write('error', event, {
				...details,
				...describeStoryError(error)
			});
		}
	};
}

export const NOOP_STORY_LOGGER: StoryLogger = {
	requestId: 'noop',
	withContext() {
		return NOOP_STORY_LOGGER;
	},
	info() {
		// Intentionally empty.
	},
	warn() {
		// Intentionally empty.
	},
	error() {
		// Intentionally empty.
	},
	trackError() {
		// Intentionally empty.
	}
};

export function createStoryRequestLogger(
	context: {
		sessionId?: string | null;
		threadId?: string | null;
		model?: string | null;
	} = {}
): StoryLogger {
	return createLogger({
		requestId: randomUUID(),
		sessionRef: toSessionRef(context.sessionId),
		threadRef: toThreadRef(context.threadId),
		model: context.model ?? null
	});
}
