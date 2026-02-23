import type { QuotaBudget } from '$lib/server/scan/quota-budget';
import { createQuotaBudget } from '$lib/server/scan/quota-budget';
import { NOOP_STORY_LOGGER, describeStoryError, type StoryLogger } from './logging';
import {
  STORY_GMAIL_API_BASE_URL,
  STORY_GMAIL_BACKOFF_BASE_MS,
  STORY_GMAIL_BACKOFF_JITTER_MAX_MS,
  STORY_GMAIL_BACKOFF_MAX_MS,
  STORY_GMAIL_CONCEPT_MAX_LENGTH,
  STORY_GMAIL_DEFAULT_DETAIL_BATCH_SIZE,
  STORY_GMAIL_DEFAULT_MAX_CONCURRENT_GMAIL,
  STORY_GMAIL_DEFAULT_MAX_CONCURRENT_LLM,
  STORY_GMAIL_DEFAULT_MAX_RETRIES,
  STORY_GMAIL_DEFAULT_MAX_UNITS,
  STORY_GMAIL_DEFAULT_SEARCH_MAX_PAGES,
  STORY_GMAIL_DEFAULT_SEARCH_PAGE_SIZE,
  STORY_GMAIL_MESSAGE_EXCERPT_MAX_LENGTH,
  STORY_GMAIL_METADATA_SCOPE_FULL_FORMAT_REASON,
  STORY_GMAIL_PARTICIPANT_NETWORK_DEFAULT_MAX_PARTICIPANTS,
  STORY_GMAIL_PARTICIPANT_NETWORK_DEFAULT_RESULTS_PER_PARTICIPANT,
  STORY_GMAIL_PARTICIPANT_NETWORK_MIN_BASE_RESULTS,
  STORY_GMAIL_RETRYABLE_403_REASONS,
  STORY_GMAIL_RETRY_AFTER_MAX_WAIT_MS,
  STORY_GMAIL_SUBJECT_HINT_MAX_LENGTH,
  STORY_GMAIL_THREAD_DISCOVERY_MULTIPLIER,
  STORY_GMAIL_THREAD_GET_UNIT_COST,
  STORY_GMAIL_THREAD_LIST_UNIT_COST
} from './config';
import type { StoryMessageExcerpt, StoryThreadProvenance, StoryThreadResearch } from './types';

type StoryResearchOptions = {
  accessToken: string;
  fetchImpl?: typeof fetch;
  budget?: QuotaBudget;
  logger?: StoryLogger;
  searchPageSize?: number;
  searchMaxPages?: number;
  detailBatchSize?: number;
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
  nextPageToken?: string;
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

type ConceptSearchOptions = StoryResearchOptions & {
  selectedThreadId: string;
  concept: string;
  maxResults?: number;
};

type TimeWindowSearchOptions = StoryResearchOptions & {
  selectedThreadId: string;
  after?: string | null;
  before?: string | null;
  maxResults?: number;
};

type ParticipantNetworkOptions = StoryResearchOptions & {
  selectedThreadId: string;
  participantEmail: string;
  maxParticipants?: number;
  maxResultsPerParticipant?: number;
};

type QueryThreadSearchOptions = StoryResearchOptions & {
  selectedThreadId: string;
  maxResults: number;
  query: string;
  provenance: StoryThreadProvenance;
};

function shouldRetry(status: number): boolean {
  return status === 429 || status >= 500;
}

type GmailErrorPayload = {
  reason: string | null;
  providerMessage: string | null;
};

function isMetadataScopeFullFormatError(
  reason: string | null,
  providerMessage: string | null
): boolean {
  if (reason !== 'forbidden') {
    return false;
  }

  return (
    typeof providerMessage === 'string' &&
    providerMessage.toLowerCase().includes("metadata scope doesn't allow format full")
  );
}

async function waitBackoff(attempt: number): Promise<void> {
  const jitterMs = Math.floor(Math.random() * STORY_GMAIL_BACKOFF_JITTER_MAX_MS);
  const delayMs = Math.min(
    STORY_GMAIL_BACKOFF_MAX_MS,
    STORY_GMAIL_BACKOFF_BASE_MS * 2 ** attempt + jitterMs
  );
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
    return reason !== null && STORY_GMAIL_RETRYABLE_403_REASONS.has(reason);
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
  const maxRetries = options.maxRetries ?? STORY_GMAIL_DEFAULT_MAX_RETRIES;
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
        ? STORY_GMAIL_METADATA_SCOPE_FULL_FORMAT_REASON
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
      throw new Error(
        `gmail_request_failed:${response.status}:${options.operation}${reasonSuffix}`
      );
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
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(STORY_GMAIL_RETRY_AFTER_MAX_WAIT_MS, retryAfterMs))
      );
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
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
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
    excerpt: trimmedBody
      ? trimmedBody.slice(0, STORY_GMAIL_MESSAGE_EXCERPT_MAX_LENGTH)
      : (message.snippet ?? null)
  };
}

function normalizeThreadProvenance(
  input: StoryThreadProvenance | StoryThreadProvenance[] | undefined
): StoryThreadProvenance[] {
  if (!input) {
    return [
      {
        source: 'selected_thread',
        query: null
      }
    ];
  }

  const values = Array.isArray(input) ? input : [input];
  const deduped = new Map<string, StoryThreadProvenance>();
  for (const item of values) {
    deduped.set(`${item.source}:${item.query ?? ''}`, item);
  }

  return [...deduped.values()];
}

function toThreadResearch(
  thread: GmailThreadResponse,
  threadId: string,
  provenance: StoryThreadProvenance | StoryThreadProvenance[] | undefined
): StoryThreadResearch {
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
    lastMessageAt: timestamps.length
      ? new Date(timestamps[timestamps.length - 1]).toISOString()
      : null,
    latestSnippet: thread.snippet ?? null,
    messages: messages.map(messageToExcerpt),
    provenance: normalizeThreadProvenance(provenance)
  };
}

function mergeProvenance(
  left: StoryThreadProvenance[],
  right: StoryThreadProvenance[]
): StoryThreadProvenance[] {
  const deduped = new Map<string, StoryThreadProvenance>();
  for (const entry of [...left, ...right]) {
    deduped.set(`${entry.source}:${entry.query ?? ''}`, entry);
  }

  return [...deduped.values()];
}

function mergeThreads(
  threads: StoryThreadResearch[],
  additional: StoryThreadResearch[]
): StoryThreadResearch[] {
  const map = new Map(threads.map((thread) => [thread.threadId, thread]));
  for (const thread of additional) {
    const existing = map.get(thread.threadId);
    if (!existing) {
      map.set(thread.threadId, thread);
      continue;
    }

    map.set(thread.threadId, {
      ...existing,
      provenance: mergeProvenance(existing.provenance, thread.provenance)
    });
  }

  return [...map.values()];
}

function toGmailDateToken(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  const year = parsed.getUTCFullYear();
  const month = String(parsed.getUTCMonth() + 1).padStart(2, '0');
  const day = String(parsed.getUTCDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

function sanitizeSubjectHint(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.replaceAll('"', '').trim();
  return normalized ? normalized.slice(0, STORY_GMAIL_SUBJECT_HINT_MAX_LENGTH) : null;
}

function withSearchDefaults(
  options: StoryResearchOptions
): Required<Pick<StoryResearchOptions, 'searchPageSize' | 'searchMaxPages' | 'detailBatchSize'>> {
  return {
    searchPageSize: Math.max(
      1,
      Math.floor(options.searchPageSize ?? STORY_GMAIL_DEFAULT_SEARCH_PAGE_SIZE)
    ),
    searchMaxPages: Math.max(
      1,
      Math.floor(options.searchMaxPages ?? STORY_GMAIL_DEFAULT_SEARCH_MAX_PAGES)
    ),
    detailBatchSize: Math.max(
      1,
      Math.floor(options.detailBatchSize ?? STORY_GMAIL_DEFAULT_DETAIL_BATCH_SIZE)
    )
  };
}

async function listThreadIdsByQuery(options: QueryThreadSearchOptions): Promise<string[]> {
  const {
    accessToken,
    query,
    maxResults,
    fetchImpl = fetch,
    budget = createStoryResearchBudget(),
    logger = NOOP_STORY_LOGGER,
    searchPageSize,
    searchMaxPages
  } = options;
  const searchDefaults = withSearchDefaults(options);

  const uniqueThreadIds = new Set<string>();
  let pageToken: string | null = null;
  let pageCount = 0;

  while (pageCount < (searchMaxPages ?? searchDefaults.searchMaxPages)) {
    budget.consumeGmailUnits(STORY_GMAIL_THREAD_LIST_UNIT_COST);

    const listResponse = await budget.withConcurrencySlot('gmail', async () => {
      const startedAt = Date.now();
      const listUrl = new URL(`${STORY_GMAIL_API_BASE_URL}/threads`);
      listUrl.searchParams.set(
        'maxResults',
        String(searchPageSize ?? searchDefaults.searchPageSize)
      );
      if (query) {
        listUrl.searchParams.set('q', query);
      }
      if (pageToken) {
        listUrl.searchParams.set('pageToken', pageToken);
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
        logger.warn('story.gmail.list_thread_ids.failed', {
          durationMs: Date.now() - startedAt,
          ...describeStoryError(error)
        });
        throw error;
      }
    });

    for (const thread of listResponse.threads ?? []) {
      if (thread.id) {
        uniqueThreadIds.add(thread.id);
      }
    }

    pageCount += 1;
    if (
      !listResponse.nextPageToken ||
      uniqueThreadIds.size >= maxResults * STORY_GMAIL_THREAD_DISCOVERY_MULTIPLIER
    ) {
      break;
    }

    pageToken = listResponse.nextPageToken;
  }

  logger.info('story.gmail.list_thread_ids.completed', {
    pagesFetched: pageCount,
    threadIdsDiscovered: uniqueThreadIds.size,
    maxResults
  });

  return [...uniqueThreadIds];
}

async function fetchThreadDetailsById(options: {
  threadIds: string[];
  selectedThreadId: string;
  maxResults: number;
  provenance: StoryThreadProvenance;
  accessToken: string;
  fetchImpl?: typeof fetch;
  budget?: QuotaBudget;
  logger?: StoryLogger;
  detailBatchSize?: number;
}): Promise<StoryThreadResearch[]> {
  const {
    threadIds,
    selectedThreadId,
    maxResults,
    provenance,
    accessToken,
    fetchImpl,
    budget,
    logger = NOOP_STORY_LOGGER,
    detailBatchSize = STORY_GMAIL_DEFAULT_DETAIL_BATCH_SIZE
  } = options;

  const filtered = threadIds
    .filter((threadId) => threadId !== selectedThreadId)
    .slice(0, Math.max(1, maxResults));

  const results: StoryThreadResearch[] = [];
  for (let index = 0; index < filtered.length; index += detailBatchSize) {
    const batch = filtered.slice(index, index + detailBatchSize);
    const fetchedBatch = await Promise.all(
      batch.map((threadId) =>
        fetchSelectedThread(threadId, {
          accessToken,
          fetchImpl,
          budget,
          logger,
          provenance
        })
      )
    );
    results.push(...fetchedBatch);
  }

  return results;
}

async function searchThreadsByQuery(
  options: QueryThreadSearchOptions
): Promise<StoryThreadResearch[]> {
  if (!options.accessToken) {
    throw new Error('gmail_access_token_missing');
  }

  const threadIds = await listThreadIdsByQuery(options);
  const results = await fetchThreadDetailsById({
    threadIds,
    selectedThreadId: options.selectedThreadId,
    maxResults: options.maxResults,
    provenance: options.provenance,
    accessToken: options.accessToken,
    fetchImpl: options.fetchImpl,
    budget: options.budget,
    logger: options.logger,
    detailBatchSize: options.detailBatchSize
  });

  (options.logger ?? NOOP_STORY_LOGGER).info('story.gmail.search_threads_by_query.completed', {
    maxResults: options.maxResults,
    returnedResults: results.length,
    source: options.provenance.source
  });

  return results;
}

export function createStoryResearchBudget(options?: {
  maxGmailUnits?: number;
  maxConcurrentGmail?: number;
  maxConcurrentLlm?: number;
}): QuotaBudget {
  return createQuotaBudget({
    maxGmailUnits: options?.maxGmailUnits ?? STORY_GMAIL_DEFAULT_MAX_UNITS,
    maxConcurrentGmail: options?.maxConcurrentGmail ?? STORY_GMAIL_DEFAULT_MAX_CONCURRENT_GMAIL,
    maxConcurrentLlm: options?.maxConcurrentLlm ?? STORY_GMAIL_DEFAULT_MAX_CONCURRENT_LLM
  });
}

export async function fetchSelectedThread(
  threadId: string,
  options: StoryResearchOptions & {
    provenance?: StoryThreadProvenance | StoryThreadProvenance[];
  }
): Promise<StoryThreadResearch> {
  if (!options.accessToken) {
    throw new Error('gmail_access_token_missing');
  }

  const budget = options.budget ?? createStoryResearchBudget();
  const fetchImpl = options.fetchImpl ?? fetch;
  const logger = options.logger ?? NOOP_STORY_LOGGER;

  budget.consumeGmailUnits(STORY_GMAIL_THREAD_GET_UNIT_COST);

  return budget.withConcurrencySlot('gmail', async () => {
    const startedAt = Date.now();
    const url = new URL(`${STORY_GMAIL_API_BASE_URL}/threads/${threadId}`);
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

      return toThreadResearch(thread, threadId, options.provenance);
    } catch (error) {
      logger.warn('story.gmail.fetch_selected_thread.failed', {
        durationMs: Date.now() - startedAt,
        ...describeStoryError(error)
      });
      throw error;
    }
  });
}

export async function searchRelatedThreads(
  options: RelatedSearchOptions
): Promise<StoryThreadResearch[]> {
  const {
    selectedThreadId,
    participant,
    subjectHint,
    maxResults = 10,
    logger = NOOP_STORY_LOGGER
  } = options;

  const querySegments: string[] = [];
  if (participant) {
    querySegments.push(`(from:${participant} OR to:${participant})`);
  }
  const sanitizedSubject = sanitizeSubjectHint(subjectHint);
  if (sanitizedSubject) {
    querySegments.push(`subject:"${sanitizedSubject}"`);
  }

  const query = querySegments.join(' ');
  const results = await searchThreadsByQuery({
    ...options,
    selectedThreadId,
    maxResults,
    query,
    provenance: {
      source: 'search_related_threads',
      query: query || null
    }
  });

  logger.info('story.gmail.search_related_threads.completed', {
    hasParticipant: Boolean(participant),
    hasSubjectHint: Boolean(sanitizedSubject),
    requestedResults: maxResults,
    returnedResults: results.length
  });

  return results;
}

export async function getParticipantHistory(
  options: ParticipantHistoryOptions
): Promise<StoryThreadResearch[]> {
  const { participant, excludeThreadId, maxResults = 10, ...shared } = options;
  const normalized = addressToEmail(participant);

  if (!normalized) {
    return [];
  }

  const query = `(from:${normalized} OR to:${normalized})`;
  const threads = await searchThreadsByQuery({
    ...shared,
    selectedThreadId: excludeThreadId ?? '',
    maxResults,
    query,
    provenance: {
      source: 'participant_history',
      query
    }
  });

  const filtered = threads.filter((thread) => thread.participants.includes(normalized));
  (shared.logger ?? NOOP_STORY_LOGGER).info('story.gmail.get_participant_history.completed', {
    requestedResults: maxResults,
    returnedResults: filtered.length
  });

  return filtered;
}

export async function searchThreadsByConcept(
  options: ConceptSearchOptions
): Promise<StoryThreadResearch[]> {
  const { concept, selectedThreadId, maxResults = 10, logger = NOOP_STORY_LOGGER } = options;
  const sanitizedConcept = concept
    .replaceAll('"', '')
    .trim()
    .slice(0, STORY_GMAIL_CONCEPT_MAX_LENGTH);

  if (!sanitizedConcept) {
    return [];
  }

  const query = `(subject:"${sanitizedConcept}" OR "${sanitizedConcept}")`;
  const results = await searchThreadsByQuery({
    ...options,
    selectedThreadId,
    maxResults,
    query,
    provenance: {
      source: 'search_threads_by_concept',
      query
    }
  });

  logger.info('story.gmail.search_threads_by_concept.completed', {
    requestedResults: maxResults,
    returnedResults: results.length
  });

  return results;
}

export async function searchThreadsByTimeWindow(
  options: TimeWindowSearchOptions
): Promise<StoryThreadResearch[]> {
  const { selectedThreadId, after, before, maxResults = 10, logger = NOOP_STORY_LOGGER } = options;
  const querySegments: string[] = [];

  const afterToken = toGmailDateToken(after);
  if (afterToken) {
    querySegments.push(`after:${afterToken}`);
  }

  const beforeToken = toGmailDateToken(before);
  if (beforeToken) {
    querySegments.push(`before:${beforeToken}`);
  }

  const query = querySegments.join(' ');
  if (!query) {
    return [];
  }

  const results = await searchThreadsByQuery({
    ...options,
    selectedThreadId,
    maxResults,
    query,
    provenance: {
      source: 'search_threads_by_time_window',
      query
    }
  });

  logger.info('story.gmail.search_threads_by_time_window.completed', {
    requestedResults: maxResults,
    returnedResults: results.length,
    hasAfter: Boolean(afterToken),
    hasBefore: Boolean(beforeToken)
  });

  return results;
}

export async function expandParticipantNetwork(
  options: ParticipantNetworkOptions
): Promise<StoryThreadResearch[]> {
  const {
    selectedThreadId,
    participantEmail,
    maxParticipants = STORY_GMAIL_PARTICIPANT_NETWORK_DEFAULT_MAX_PARTICIPANTS,
    maxResultsPerParticipant = STORY_GMAIL_PARTICIPANT_NETWORK_DEFAULT_RESULTS_PER_PARTICIPANT,
    logger = NOOP_STORY_LOGGER
  } = options;
  const normalizedParticipant = addressToEmail(participantEmail);

  if (!normalizedParticipant) {
    return [];
  }

  const baseThreads = await getParticipantHistory({
    ...options,
    participant: normalizedParticipant,
    excludeThreadId: selectedThreadId,
    maxResults: Math.max(
      maxResultsPerParticipant,
      STORY_GMAIL_PARTICIPANT_NETWORK_MIN_BASE_RESULTS
    )
  });

  const participantNeighbors = new Set<string>();
  for (const thread of baseThreads) {
    for (const participant of thread.participants) {
      if (participant && participant !== normalizedParticipant) {
        participantNeighbors.add(participant);
      }
    }
  }

  let aggregated = baseThreads.map((thread) => ({
    ...thread,
    provenance: mergeProvenance(thread.provenance, [
      {
        source: 'expand_participant_network',
        query: normalizedParticipant
      }
    ])
  }));

  const neighbors = [...participantNeighbors].slice(0, Math.max(1, maxParticipants));
  for (const neighbor of neighbors) {
    const neighborThreads = await searchRelatedThreads({
      ...options,
      selectedThreadId,
      participant: neighbor,
      maxResults: maxResultsPerParticipant
    });

    aggregated = mergeThreads(
      aggregated,
      neighborThreads.map((thread) => ({
        ...thread,
        provenance: mergeProvenance(thread.provenance, [
          {
            source: 'expand_participant_network',
            query: neighbor
          }
        ])
      }))
    );
  }

  logger.info('story.gmail.expand_participant_network.completed', {
    neighborCount: neighbors.length,
    requestedResultsPerParticipant: maxResultsPerParticipant,
    returnedResults: aggregated.length
  });

  return aggregated;
}
