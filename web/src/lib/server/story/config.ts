import type { StoryExplorationOptions, StoryExplorationProfile } from './types';

export const STORY_DEFAULT_MODEL = 'openai/gpt-4o-mini';
export const STORY_MAX_LLM_RETRIES = 2;

export const STORY_OPENROUTER_ZERO_RETENTION_DEFAULTS = {
  provider: {
    allow_fallbacks: false,
    data_collection: 'deny',
    zdr: true
  }
} as const;

export const STORY_LLM_BACKOFF_BASE_MS = 180;
export const STORY_LLM_BACKOFF_MAX_MS = 1_500;
export const STORY_LLM_BACKOFF_JITTER_MAX_MS = 90;

export const STORY_SEED_PARTICIPANTS_LIMIT = 8;
export const STORY_CONCEPT_HINT_LIMIT = 8;
export const STORY_SELECTED_MESSAGES_FOR_HINTS = 3;
export const STORY_TOKEN_PATTERN = /[a-z][a-z0-9-]{3,}/g;

export const STORY_PARTICIPANT_HISTORY_FALLBACK_RESULTS = 3;
export const STORY_TIMELINE_FALLBACK_WINDOW_DAYS = 14;
export const STORY_TIMELINE_FALLBACK_RESULTS = 3;
export const STORY_NETWORK_FALLBACK_PARTICIPANTS = 2;
export const STORY_NETWORK_FALLBACK_RESULTS_PER_PARTICIPANT = 2;
export const STORY_SEARCH_MIN_RESULTS_FALLBACK = 2;

export const STORY_GMAIL_API_BASE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const STORY_GMAIL_THREAD_LIST_UNIT_COST = 10;
export const STORY_GMAIL_THREAD_GET_UNIT_COST = 10;
export const STORY_GMAIL_METADATA_SCOPE_FULL_FORMAT_REASON = 'metadataScopeFullFormatForbidden';
export const STORY_GMAIL_DEFAULT_SEARCH_PAGE_SIZE = 18;
export const STORY_GMAIL_DEFAULT_SEARCH_MAX_PAGES = 2;
export const STORY_GMAIL_DEFAULT_DETAIL_BATCH_SIZE = 3;
export const STORY_GMAIL_DEFAULT_MAX_RETRIES = 3;
export const STORY_GMAIL_DEFAULT_MAX_UNITS = 220;
export const STORY_GMAIL_DEFAULT_MAX_CONCURRENT_GMAIL = 3;
export const STORY_GMAIL_DEFAULT_MAX_CONCURRENT_LLM = 1;
export const STORY_GMAIL_BACKOFF_BASE_MS = 180;
export const STORY_GMAIL_BACKOFF_MAX_MS = 2_500;
export const STORY_GMAIL_BACKOFF_JITTER_MAX_MS = 120;
export const STORY_GMAIL_RETRY_AFTER_MAX_WAIT_MS = 5_000;
export const STORY_GMAIL_THREAD_DISCOVERY_MULTIPLIER = 3;
export const STORY_GMAIL_SUBJECT_HINT_MAX_LENGTH = 180;
export const STORY_GMAIL_CONCEPT_MAX_LENGTH = 100;
export const STORY_GMAIL_MESSAGE_EXCERPT_MAX_LENGTH = 1_200;
export const STORY_GMAIL_PARTICIPANT_NETWORK_DEFAULT_MAX_PARTICIPANTS = 5;
export const STORY_GMAIL_PARTICIPANT_NETWORK_DEFAULT_RESULTS_PER_PARTICIPANT = 10;
export const STORY_GMAIL_PARTICIPANT_NETWORK_MIN_BASE_RESULTS = 10;

export const STORY_GMAIL_RETRYABLE_403_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'backendError',
  'internalError'
]);

export const STORY_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'that',
  'with',
  'from',
  'this',
  'about',
  'have',
  'will',
  'were',
  'been',
  'just',
  'into',
  'your',
  'ours',
  'they',
  'them',
  'please',
  'thank',
  'email',
  'thread'
]);

type StoryExplorationProfileConfig = {
  maxResearchSteps: number;
  minRelatedThreads: number;
  minParticipantHistories: number;
  minConceptThreads: number;
  maxGmailUnits: number;
  maxConcurrentGmail: number;
  searchPageSize: number;
  searchMaxPages: number;
  detailBatchSize: number;
};

const STORY_EXPLORATION_HARD_CAPS = {
  maxResearchSteps: 18,
  minRelatedThreads: 20,
  minParticipantHistories: 20,
  minConceptThreads: 20,
  searchPageSize: 50,
  searchMaxPages: 20,
  detailBatchSize: 20
} as const;

export const STORY_EXPLORATION_PROFILE_DEFAULTS: Record<
  StoryExplorationProfile,
  StoryExplorationProfileConfig
> = {
  fast: {
    maxResearchSteps: 4,
    minRelatedThreads: 2,
    minParticipantHistories: 1,
    minConceptThreads: 1,
    maxGmailUnits: 220,
    maxConcurrentGmail: 3,
    searchPageSize: 12,
    searchMaxPages: 2,
    detailBatchSize: 2
  },
  balanced: {
    maxResearchSteps: 7,
    minRelatedThreads: 4,
    minParticipantHistories: 2,
    minConceptThreads: 2,
    maxGmailUnits: 520,
    maxConcurrentGmail: 4,
    searchPageSize: 18,
    searchMaxPages: 3,
    detailBatchSize: 4
  },
  deep: {
    maxResearchSteps: 20,
    minRelatedThreads: 10,
    minParticipantHistories: 10,
    minConceptThreads: 10,
    maxGmailUnits: 4000,
    maxConcurrentGmail: 10,
    searchPageSize: 30,
    searchMaxPages: 10,
    detailBatchSize: 10
  }
};

export type StoryEffectiveExplorationSettings = StoryExplorationProfileConfig & {
  profile: StoryExplorationProfile;
};

function clamp(value: number | undefined, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, Math.floor(value)));
}

function resolveOverride(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function resolveStoryExplorationSettings(
  exploration?: StoryExplorationOptions
): StoryEffectiveExplorationSettings {
  const profile = exploration?.profile ?? 'deep';
  const base = STORY_EXPLORATION_PROFILE_DEFAULTS[profile];

  return {
    profile,
    maxResearchSteps: resolveOverride(
      exploration?.maxResearchSteps,
      base.maxResearchSteps,
      1,
      STORY_EXPLORATION_HARD_CAPS.maxResearchSteps
    ),
    minRelatedThreads: resolveOverride(
      exploration?.minRelatedThreads,
      base.minRelatedThreads,
      0,
      STORY_EXPLORATION_HARD_CAPS.minRelatedThreads
    ),
    minParticipantHistories: resolveOverride(
      exploration?.minParticipantHistories,
      base.minParticipantHistories,
      0,
      STORY_EXPLORATION_HARD_CAPS.minParticipantHistories
    ),
    minConceptThreads: resolveOverride(
      exploration?.minConceptThreads,
      base.minConceptThreads,
      0,
      STORY_EXPLORATION_HARD_CAPS.minConceptThreads
    ),
    maxGmailUnits: base.maxGmailUnits,
    maxConcurrentGmail: base.maxConcurrentGmail,
    searchPageSize: clamp(base.searchPageSize, 1, STORY_EXPLORATION_HARD_CAPS.searchPageSize),
    searchMaxPages: clamp(base.searchMaxPages, 1, STORY_EXPLORATION_HARD_CAPS.searchMaxPages),
    detailBatchSize: clamp(base.detailBatchSize, 1, STORY_EXPLORATION_HARD_CAPS.detailBatchSize)
  };
}
