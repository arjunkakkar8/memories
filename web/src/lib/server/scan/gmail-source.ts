import { QuotaBudgetError, type QuotaBudget } from './quota-budget';
import type { ScanThreadMetadata } from './types';

const GMAIL_API_BASE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const THREADS_LIST_UNIT_COST = 10;
const THREAD_GET_UNIT_COST = 10;

type GmailListResponse = {
  nextPageToken?: string;
  threads?: Array<{
    id?: string;
    historyId?: string;
  }>;
};

type GmailThreadResponse = {
  id?: string;
  historyId?: string;
  snippet?: string;
  messages?: Array<{
    internalDate?: string;
    payload?: {
      headers?: Array<{
        name?: string;
        value?: string;
      }>;
    };
  }>;
};

type FetchOptions = {
  accessToken: string;
  budget: QuotaBudget;
  fetchImpl?: typeof fetch;
  query?: string;
  pageSize?: number;
  maxPages?: number;
  maxThreads?: number;
  threadDetailsConcurrency?: number;
};

function parseParticipants(messages: NonNullable<GmailThreadResponse['messages']>): string[] {
  const participants = new Set<string>();

  for (const message of messages) {
    for (const header of message.payload?.headers ?? []) {
      if (!header.name || !header.value) {
        continue;
      }

      const headerName = header.name.toLowerCase();
      if (headerName !== 'from' && headerName !== 'to' && headerName !== 'cc') {
        continue;
      }

      for (const rawParticipant of header.value.split(',')) {
        const normalized = rawParticipant.trim();
        if (normalized) {
          participants.add(normalized);
        }
      }
    }
  }

  return [...participants];
}

function parseThreadSubject(messages: NonNullable<GmailThreadResponse['messages']>): string | null {
  for (const message of messages) {
    for (const header of message.payload?.headers ?? []) {
      if (header.name?.toLowerCase() === 'subject' && header.value) {
        return header.value;
      }
    }
  }

  return null;
}

function extractThreadDates(messages: NonNullable<GmailThreadResponse['messages']>): {
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

    return {
      threadId: thread.id ?? threadId,
      historyId: thread.historyId ?? null,
      subject: parseThreadSubject(messages),
      participants: parseParticipants(messages),
      messageCount: messages.length,
      firstMessageAt: dates.firstMessageAt,
      lastMessageAt: dates.lastMessageAt,
      latestSnippet: thread.snippet ?? null
    };
  });
}

export async function fetchGmailThreadMetadata(options: FetchOptions): Promise<ScanThreadMetadata[]> {
  const {
    accessToken,
    budget,
    fetchImpl = fetch,
    query,
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

  for (let index = 0; index < dedupedThreadIds.length;) {
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
    return error.message.startsWith('gmail_request_failed:') || error.message === 'gmail_access_token_missing';
  }

  return false;
}
