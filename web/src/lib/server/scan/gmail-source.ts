import { QuotaBudgetError, type QuotaBudget } from './quota-budget';
import type { ScanThreadMetadata } from './types';

const GMAIL_API_BASE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const THREADS_LIST_UNIT_COST = 10;
const THREAD_GET_UNIT_COST = 10;
const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

type GmailListResponse = {
	nextPageToken?: string;
	threads?: Array<{
		id?: string;
		historyId?: string;
	}>;
};

type GmailMessage = {
	internalDate?: string;
	labelIds?: string[];
	payload?: {
		headers?: Array<{
			name?: string;
			value?: string;
		}>;
	};
};

type GmailThreadResponse = {
	id?: string;
	historyId?: string;
	snippet?: string;
	messages?: GmailMessage[];
};

type FetchOptions = {
	accessToken: string;
	budget: QuotaBudget;
	fetchImpl?: typeof fetch;
	query?: string;
	labelIds?: string[];
	pageSize?: number;
	maxPages?: number;
	maxThreads?: number;
	threadDetailsConcurrency?: number;
};

function normalizeLexicalText(value: string | null | undefined): string {
	if (!value) {
		return '';
	}

	return value
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function collectHeaderValues(messages: GmailMessage[], headerName: string): string[] {
	const normalizedHeader = headerName.toLowerCase();
	const values: string[] = [];

	for (const message of messages) {
		for (const header of message.payload?.headers ?? []) {
			if (header.name?.toLowerCase() === normalizedHeader && header.value) {
				values.push(header.value);
			}
		}
	}

	return values;
}

function parseAddressTokens(rawValue: string): string[] {
	const matchedEmails = rawValue.match(EMAIL_PATTERN) ?? [];
	if (matchedEmails.length > 0) {
		return matchedEmails.map((value) => value.toLowerCase());
	}

	const fallback = rawValue.trim().toLowerCase();
	return fallback ? [fallback] : [];
}

function parseParticipants(messages: GmailMessage[]): {
	participants: string[];
	normalized: string[];
} {
	const rawParticipants = new Set<string>();
	const normalized = new Set<string>();

	for (const headerName of ['from', 'to', 'cc']) {
		for (const rawValue of collectHeaderValues(messages, headerName)) {
			rawParticipants.add(rawValue.trim());
			for (const normalizedAddress of parseAddressTokens(rawValue)) {
				normalized.add(normalizedAddress);
			}
		}
	}

	return {
		participants: [...rawParticipants].filter(Boolean),
		normalized: [...normalized]
	};
}

function parseThreadSubject(messages: GmailMessage[]): string | null {
	for (const message of messages) {
		for (const header of message.payload?.headers ?? []) {
			if (header.name?.toLowerCase() === 'subject' && header.value) {
				return header.value;
			}
		}
	}

	return null;
}

function extractThreadDates(messages: GmailMessage[]): {
	firstMessageAt: string | null;
	lastMessageAt: string | null;
} {
	const sortedDates = messages
		.map((message) => Number(message.internalDate ?? 0))
		.filter((value) => Number.isFinite(value) && value > 0)
		.sort((a, b) => a - b);

	if (sortedDates.length === 0) {
		return {
			firstMessageAt: null,
			lastMessageAt: null
		};
	}

	return {
		firstMessageAt: new Date(sortedDates[0]).toISOString(),
		lastMessageAt: new Date(sortedDates[sortedDates.length - 1]).toISOString()
	};
}

function collectLabelIds(messages: GmailMessage[]): string[] {
	const labels = new Set<string>();
	for (const message of messages) {
		for (const label of message.labelIds ?? []) {
			if (label) {
				labels.add(label);
			}
		}
	}

	return [...labels];
}

function toSenderDetails(messages: GmailMessage[]): { addresses: string[]; domains: string[] } {
	const senderAddresses = new Set<string>();
	const senderDomains = new Set<string>();

	for (const rawFrom of collectHeaderValues(messages, 'from')) {
		for (const address of parseAddressTokens(rawFrom)) {
			senderAddresses.add(address);
			const domain = address.split('@')[1];
			if (domain) {
				senderDomains.add(domain);
			}
		}
	}

	return {
		addresses: [...senderAddresses],
		domains: [...senderDomains]
	};
}

function shouldRetry(status: number): boolean {
	return status === 429 || status === 403 || status >= 500;
}

async function waitBackoff(attempt: number): Promise<void> {
	const delayMs = Math.min(1_000, 150 * 2 ** attempt);
	await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function fetchWithRetry<T>(
	url: URL,
	init: RequestInit,
	fetchImpl: typeof fetch,
	maxRetries = 3
): Promise<T> {
	for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
		const response = await fetchImpl(url, init);

		if (response.ok) {
			return (await response.json()) as T;
		}

		if (!shouldRetry(response.status) || attempt === maxRetries) {
			throw new Error(`gmail_request_failed:${response.status}`);
		}

		await waitBackoff(attempt);
	}

	throw new Error('gmail_request_failed:unknown');
}

async function fetchThreadDetails(params: {
	threadId: string;
	accessToken: string;
	budget: QuotaBudget;
	fetchImpl: typeof fetch;
}): Promise<ScanThreadMetadata> {
	const { threadId, accessToken, budget, fetchImpl } = params;

	budget.consumeGmailUnits(THREAD_GET_UNIT_COST);

	return budget.withConcurrencySlot('gmail', async () => {
		const url = new URL(`${GMAIL_API_BASE_URL}/threads/${threadId}`);
		url.searchParams.set('format', 'metadata');
		url.searchParams.append('metadataHeaders', 'Subject');
		url.searchParams.append('metadataHeaders', 'From');
		url.searchParams.append('metadataHeaders', 'To');
		url.searchParams.append('metadataHeaders', 'Cc');

		const thread = await fetchWithRetry<GmailThreadResponse>(
			url,
			{
				method: 'GET',
				headers: {
					authorization: `Bearer ${accessToken}`
				}
			},
			fetchImpl
		);

		const messages = thread.messages ?? [];
		const dates = extractThreadDates(messages);
		const participantResult = parseParticipants(messages);
		const senderDetails = toSenderDetails(messages);
		const labelIds = collectLabelIds(messages);

		return {
			threadId: thread.id ?? threadId,
			historyId: thread.historyId ?? null,
			subject: parseThreadSubject(messages),
			participants: participantResult.participants,
			participantsNormalized: participantResult.normalized,
			senderAddresses: senderDetails.addresses,
			senderDomains: senderDetails.domains,
			labelIds,
			importanceMarkers: {
				important: labelIds.includes('IMPORTANT'),
				starred: labelIds.includes('STARRED'),
				hasUserLabels: labelIds.some((label) => label.startsWith('Label_'))
			},
			subjectLexical: normalizeLexicalText(parseThreadSubject(messages)),
			snippetLexical: normalizeLexicalText(thread.snippet),
			messageCount: messages.length,
			firstMessageAt: dates.firstMessageAt,
			lastMessageAt: dates.lastMessageAt,
			latestSnippet: thread.snippet ?? null,
			retrieval: {
				hitCount: 0,
				packIds: [],
				windowIds: [],
				hits: []
			}
		};
	});
}

export async function fetchGmailThreadMetadata(
	options: FetchOptions
): Promise<ScanThreadMetadata[]> {
	const {
		accessToken,
		budget,
		fetchImpl = fetch,
		query,
		labelIds,
		pageSize = 100,
		maxPages = 4,
		maxThreads = 400,
		threadDetailsConcurrency = 3
	} = options;

	if (!accessToken) {
		throw new Error('gmail_access_token_missing');
	}

	const threadIds: string[] = [];
	let pageToken: string | undefined;

	for (let page = 0; page < maxPages; page += 1) {
		if (budget.snapshot().remainingGmailUnits < THREADS_LIST_UNIT_COST) {
			break;
		}

		budget.consumeGmailUnits(THREADS_LIST_UNIT_COST);

		const listResponse = await budget.withConcurrencySlot('gmail', async () => {
			const listUrl = new URL(`${GMAIL_API_BASE_URL}/threads`);
			listUrl.searchParams.set('maxResults', String(pageSize));
			if (query) {
				listUrl.searchParams.set('q', query);
			}
			for (const labelId of labelIds ?? []) {
				if (labelId) {
					listUrl.searchParams.append('labelIds', labelId);
				}
			}
			if (pageToken) {
				listUrl.searchParams.set('pageToken', pageToken);
			}

			return fetchWithRetry<GmailListResponse>(
				listUrl,
				{
					method: 'GET',
					headers: {
						authorization: `Bearer ${accessToken}`
					}
				},
				fetchImpl
			);
		});

		for (const thread of listResponse.threads ?? []) {
			if (thread.id) {
				threadIds.push(thread.id);
			}
			if (threadIds.length >= maxThreads) {
				break;
			}
		}

		if (threadIds.length >= maxThreads || !listResponse.nextPageToken) {
			break;
		}

		pageToken = listResponse.nextPageToken;
	}

	const dedupedThreadIds = [...new Set(threadIds)];
	const metadata: ScanThreadMetadata[] = [];

	for (let index = 0; index < dedupedThreadIds.length; ) {
		const remainingUnits = budget.snapshot().remainingGmailUnits;
		const affordableDetails = Math.floor(remainingUnits / THREAD_GET_UNIT_COST);

		if (affordableDetails <= 0) {
			break;
		}

		const batchSize = Math.min(
			threadDetailsConcurrency,
			affordableDetails,
			dedupedThreadIds.length - index
		);
		const batch = dedupedThreadIds.slice(index, index + batchSize);
		const results = await Promise.all(
			batch.map((threadId) =>
				fetchThreadDetails({
					threadId,
					accessToken,
					budget,
					fetchImpl
				})
			)
		);

		metadata.push(...results);
		index += batch.length;
	}

	return metadata;
}

export function isRecoverableGmailError(error: unknown): boolean {
	if (error instanceof QuotaBudgetError) {
		return true;
	}

	if (error instanceof Error) {
		return (
			error.message.startsWith('gmail_request_failed:') ||
			error.message === 'gmail_access_token_missing'
		);
	}

	return false;
}
