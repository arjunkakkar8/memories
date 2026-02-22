import type { QuotaBudget } from '$lib/server/scan/quota-budget';
import { createQuotaBudget } from '$lib/server/scan/quota-budget';
import { NOOP_STORY_LOGGER, describeStoryError, type StoryLogger } from './logging';
import type { StoryMessageExcerpt, StoryThreadResearch } from './types';

const GMAIL_API_BASE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const THREAD_LIST_UNIT_COST = 10;
const THREAD_GET_UNIT_COST = 10;
const METADATA_SCOPE_FULL_FORMAT_REASON = 'metadataScopeFullFormatForbidden';

type StoryResearchOptions = {
	accessToken: string;
	fetchImpl?: typeof fetch;
	budget?: QuotaBudget;
	logger?: StoryLogger;
};

type GmailHeader = {
	name?: string;
	value?: string;
};

type GmailMessagePart = {
	mimeType?: string;
	body?: {
		data?: string;
	};
	parts?: GmailMessagePart[];
};

type GmailMessage = {
	id?: string;
	internalDate?: string;
	snippet?: string;
	payload?: {
		headers?: GmailHeader[];
		body?: {
			data?: string;
		};
		parts?: GmailMessagePart[];
	};
};

type GmailThreadResponse = {
	id?: string;
	historyId?: string;
	snippet?: string;
	messages?: GmailMessage[];
};

type GmailThreadListResponse = {
	threads?: Array<{
		id?: string;
	}>;
};

type RelatedSearchOptions = StoryResearchOptions & {
	selectedThreadId: string;
	participant?: string;
	subjectHint?: string;
	maxResults?: number;
};

type ParticipantHistoryOptions = StoryResearchOptions & {
	participant: string;
	excludeThreadId?: string;
	maxResults?: number;
};

function shouldRetry(status: number): boolean {
	return status === 429 || status >= 500;
}

const RETRYABLE_403_REASONS = new Set([
	'rateLimitExceeded',
	'userRateLimitExceeded',
	'backendError',
	'internalError'
]);

type GmailErrorPayload = {
	reason: string | null;
	providerMessage: string | null;
};

function isMetadataScopeFullFormatError(reason: string | null, providerMessage: string | null): boolean {
	if (reason !== 'forbidden') {
		return false;
	}

	return (
		typeof providerMessage === 'string' &&
		providerMessage.toLowerCase().includes("metadata scope doesn't allow format full")
	);
}

async function waitBackoff(attempt: number): Promise<void> {
	const jitterMs = Math.floor(Math.random() * 120);
	const delayMs = Math.min(2_500, 180 * 2 ** attempt + jitterMs);
	await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function parseRetryAfterMs(value: string | null): number | null {
	if (!value) {
		return null;
	}

	const asSeconds = Number(value);
	if (Number.isFinite(asSeconds) && asSeconds >= 0) {
		return asSeconds * 1000;
	}

	const asDate = Date.parse(value);
	if (Number.isFinite(asDate)) {
		return Math.max(0, asDate - Date.now());
	}

	return null;
}

async function parseGmailErrorPayload(response: Response): Promise<GmailErrorPayload> {
	try {
		const body = (await response.clone().json()) as {
			error?: {
				message?: unknown;
				errors?: Array<{
					reason?: unknown;
				}>;
			};
		};

		const reasonRaw = body.error?.errors?.[0]?.reason;
		const providerMessageRaw = body.error?.message;
		return {
			reason: typeof reasonRaw === 'string' ? reasonRaw : null,
			providerMessage: typeof providerMessageRaw === 'string' ? providerMessageRaw : null
		};
	} catch {
		return {
			reason: null,
			providerMessage: null
		};
	}
}

function shouldRetryWithReason(status: number, reason: string | null): boolean {
	if (status === 403) {
		return reason !== null && RETRYABLE_403_REASONS.has(reason);
	}

	return shouldRetry(status);
}

async function fetchWithRetry<T>(
	url: URL,
	init: RequestInit,
	fetchImpl: typeof fetch,
	options: {
		maxRetries?: number;
		operation: string;
		logger?: StoryLogger;
	}
): Promise<T> {
	const maxRetries = options.maxRetries ?? 3;
	const logger = options.logger ?? NOOP_STORY_LOGGER;

	for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
		const attemptNumber = attempt + 1;
		const startedAt = Date.now();
		const response = await fetchImpl(url, init);

		if (response.ok) {
			logger.info('story.gmail.request.succeeded', {
				operation: options.operation,
				attempt: attemptNumber,
				durationMs: Date.now() - startedAt
			});
			return (await response.json()) as T;
		}

		const { reason, providerMessage } = await parseGmailErrorPayload(response);
		const retryable = shouldRetryWithReason(response.status, reason);

		if (!retryable || attempt === maxRetries) {
			const normalizedReason = isMetadataScopeFullFormatError(reason, providerMessage)
				? METADATA_SCOPE_FULL_FORMAT_REASON
				: reason;

			logger.warn('story.gmail.request.failed', {
				operation: options.operation,
				attempt: attemptNumber,
				status: response.status,
				reason: normalizedReason,
				providerMessage,
				durationMs: Date.now() - startedAt,
				willRetry: false
			});
			const reasonSuffix = normalizedReason ? `:${normalizedReason}` : '';
			throw new Error(`gmail_request_failed:${response.status}:${options.operation}${reasonSuffix}`);
		}

		const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
		logger.warn('story.gmail.request.failed', {
			operation: options.operation,
			attempt: attemptNumber,
			status: response.status,
			reason,
			providerMessage,
			durationMs: Date.now() - startedAt,
			retryAfterMs,
			willRetry: true
		});

		if (retryAfterMs !== null) {
			await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, retryAfterMs)));
		} else {
			await waitBackoff(attempt);
		}
	}

	throw new Error('gmail_request_failed:unknown');
}

function getHeaderValue(headers: GmailHeader[] | undefined, key: string): string | null {
	for (const header of headers ?? []) {
		if (header.name?.toLowerCase() === key.toLowerCase() && header.value) {
			return header.value;
		}
	}

	return null;
}

function parseAddressList(raw: string | null): string[] {
	if (!raw) {
		return [];
	}

	return raw
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function addressToEmail(entry: string): string {
	const match = entry.match(/<([^>]+)>/);
	return (match?.[1] ?? entry).trim().toLowerCase();
}

function decodeBase64Url(value: string): string {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
	return Buffer.from(padded, 'base64').toString('utf-8');
}

function extractBodyFromParts(parts: GmailMessagePart[] | undefined): string {
	if (!parts || parts.length === 0) {
		return '';
	}

	for (const part of parts) {
		if (part.mimeType === 'text/plain' && part.body?.data) {
			return decodeBase64Url(part.body.data);
		}

		const nested = extractBodyFromParts(part.parts);
		if (nested) {
			return nested;
		}
	}

	return '';
}

function messageToExcerpt(message: GmailMessage): StoryMessageExcerpt {
	const headers = message.payload?.headers;
	const plainBody = message.payload?.body?.data
		? decodeBase64Url(message.payload.body.data)
		: extractBodyFromParts(message.payload?.parts);
	const trimmedBody = plainBody.replace(/\s+/g, ' ').trim();

	return {
		messageId: message.id ?? '',
		sentAt: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null,
		from: getHeaderValue(headers, 'From'),
		to: parseAddressList(getHeaderValue(headers, 'To')),
		cc: parseAddressList(getHeaderValue(headers, 'Cc')),
		subject: getHeaderValue(headers, 'Subject'),
		excerpt: trimmedBody ? trimmedBody.slice(0, 1_200) : message.snippet ?? null
	};
}

function toThreadResearch(thread: GmailThreadResponse, threadId: string): StoryThreadResearch {
	const messages = thread.messages ?? [];
	const timestamps = messages
		.map((message) => Number(message.internalDate ?? 0))
		.filter((value) => Number.isFinite(value) && value > 0)
		.sort((left, right) => left - right);

	const participants = new Set<string>();
	for (const message of messages) {
		const headers = message.payload?.headers;
		for (const header of ['From', 'To', 'Cc']) {
			for (const value of parseAddressList(getHeaderValue(headers, header))) {
				const email = addressToEmail(value);
				if (email) {
					participants.add(email);
				}
			}
		}
	}

	return {
		threadId: thread.id ?? threadId,
		historyId: thread.historyId ?? null,
		subject: getHeaderValue(messages[0]?.payload?.headers, 'Subject'),
		participants: [...participants],
		messageCount: messages.length,
		firstMessageAt: timestamps.length ? new Date(timestamps[0]).toISOString() : null,
		lastMessageAt: timestamps.length ? new Date(timestamps[timestamps.length - 1]).toISOString() : null,
		latestSnippet: thread.snippet ?? null,
		messages: messages.map(messageToExcerpt)
	};
}

export function createStoryResearchBudget(): QuotaBudget {
	return createQuotaBudget({
		maxGmailUnits: 220,
		maxConcurrentGmail: 3,
		maxConcurrentLlm: 1
	});
}

export async function fetchSelectedThread(
	threadId: string,
	options: StoryResearchOptions
): Promise<StoryThreadResearch> {
	if (!options.accessToken) {
		throw new Error('gmail_access_token_missing');
	}

	const budget = options.budget ?? createStoryResearchBudget();
	const fetchImpl = options.fetchImpl ?? fetch;
	const logger = options.logger ?? NOOP_STORY_LOGGER;

	budget.consumeGmailUnits(THREAD_GET_UNIT_COST);

	return budget.withConcurrencySlot('gmail', async () => {
		const startedAt = Date.now();
		const url = new URL(`${GMAIL_API_BASE_URL}/threads/${threadId}`);
		url.searchParams.set('format', 'full');

		try {
			const thread = await fetchWithRetry<GmailThreadResponse>(
				url,
				{
					method: 'GET',
					headers: {
						authorization: `Bearer ${options.accessToken}`
					}
				},
				fetchImpl,
				{
					operation: 'threads.get',
					logger
				}
			);

			return toThreadResearch(thread, threadId);
		} catch (error) {
			logger.warn('story.gmail.fetch_selected_thread.failed', {
				durationMs: Date.now() - startedAt,
				...describeStoryError(error)
			});
			throw error;
		}
	});
}

export async function searchRelatedThreads(options: RelatedSearchOptions): Promise<StoryThreadResearch[]> {
	const {
		accessToken,
		selectedThreadId,
		participant,
		subjectHint,
		maxResults = 4,
		fetchImpl = fetch,
		budget = createStoryResearchBudget(),
		logger = NOOP_STORY_LOGGER
	} = options;

	if (!accessToken) {
		throw new Error('gmail_access_token_missing');
	}

	const querySegments: string[] = [];
	if (participant) {
		querySegments.push(`(from:${participant} OR to:${participant})`);
	}
	if (subjectHint) {
		querySegments.push(`subject:"${subjectHint.replaceAll('"', '')}"`);
	}

	budget.consumeGmailUnits(THREAD_LIST_UNIT_COST);

	const listResponse = await budget.withConcurrencySlot('gmail', async () => {
		const startedAt = Date.now();
		const listUrl = new URL(`${GMAIL_API_BASE_URL}/threads`);
		listUrl.searchParams.set('maxResults', String(Math.max(1, maxResults * 2)));
		if (querySegments.length > 0) {
			listUrl.searchParams.set('q', querySegments.join(' '));
		}

		try {
			return await fetchWithRetry<GmailThreadListResponse>(
				listUrl,
				{
					method: 'GET',
					headers: {
						authorization: `Bearer ${accessToken}`
					}
				},
				fetchImpl,
				{
					operation: 'threads.list',
					logger
				}
			);
		} catch (error) {
			logger.warn('story.gmail.search_related_threads_list.failed', {
				durationMs: Date.now() - startedAt,
				...describeStoryError(error)
			});
			throw error;
		}
	});

	const threadIds = [...new Set((listResponse.threads ?? []).map((thread) => thread.id).filter(Boolean) as string[])];
	const filtered = threadIds.filter((threadId) => threadId !== selectedThreadId).slice(0, maxResults);

	const results: StoryThreadResearch[] = [];
	for (const threadId of filtered) {
		results.push(
			await fetchSelectedThread(threadId, {
				accessToken,
				fetchImpl,
				budget,
				logger
			})
		);
	}

	logger.info('story.gmail.search_related_threads.completed', {
		hasParticipant: Boolean(participant),
		hasSubjectHint: Boolean(subjectHint),
		requestedResults: maxResults,
		returnedResults: results.length
	});

	return results;
}

export async function getParticipantHistory(options: ParticipantHistoryOptions): Promise<StoryThreadResearch[]> {
	const { participant, excludeThreadId, maxResults = 3, ...shared } = options;
	const normalized = addressToEmail(participant);

	if (!normalized) {
		return [];
	}

	const results = await searchRelatedThreads({
		...shared,
		selectedThreadId: excludeThreadId ?? '',
		participant: normalized,
		maxResults
	});

	const filtered = results.filter((thread) => thread.participants.includes(normalized));
	(shared.logger ?? NOOP_STORY_LOGGER).info('story.gmail.get_participant_history.completed', {
		requestedResults: maxResults,
		returnedResults: filtered.length
	});

	return filtered;
}
