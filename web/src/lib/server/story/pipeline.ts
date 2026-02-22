import { OPENROUTER_API_KEY, OPENROUTER_MODEL } from '$env/static/private';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateText, stepCountIs } from 'ai';
import { buildStoryResearchPrompt, buildStoryWriterPrompt, STORY_RESEARCH_SYSTEM_PROMPT, STORY_WRITER_SYSTEM_PROMPT } from './prompt';
import { createStoryResearchBudget, fetchSelectedThread } from './gmail-research';
import { NOOP_STORY_LOGGER, describeStoryError, parseStatusCode } from './logging';
import { buildStoryResearchContext, createStoryToolRuntime } from './tools';
import type { StoryPipelineOptions, StoryPipelineResult } from './types';

const DEFAULT_MODEL = OPENROUTER_MODEL || 'openai/gpt-4o-mini';
const MAX_RESEARCH_STEPS = 6;
const MAX_LLM_RETRIES = 2;

export const OPENROUTER_ZERO_RETENTION_DEFAULTS = {
  provider: {
    allow_fallbacks: false,
    data_collection: 'deny',
    zdr: true
  }
} as const;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoffMs(attempt: number): number {
  const jitter = Math.floor(Math.random() * 90);
  return Math.min(1_500, 180 * 2 ** attempt + jitter);
}

function shouldRetryLlmCall(error: unknown): boolean {
  if (error instanceof Error && error.message.startsWith('gmail_request_failed:')) {
    return false;
  }

  if (error instanceof Error && error.message.startsWith('story_')) {
    return false;
  }

  const details = describeStoryError(error);
  return details.retryable;
}

function normalizeLlmError(error: unknown): Error {
  if (error instanceof Error && error.message.startsWith('gmail_request_failed:')) {
    return error;
  }

  if (error instanceof Error && error.message.startsWith('story_')) {
    return error;
  }

  if (!(error instanceof Error)) {
    return new Error('openrouter_request_failed:unknown');
  }

  const status = parseStatusCode(error);
  if (status !== null) {
    return new Error(`openrouter_request_failed:${status}`);
  }

  return error;
}

function budgetSnapshot(budget: ReturnType<typeof createStoryResearchBudget>): Record<string, unknown> {
  if (typeof budget.snapshot === 'function') {
    return budget.snapshot() as Record<string, unknown>;
  }

  return {};
}

type GenerateTextRequest = Parameters<typeof generateText>[0];
type GenerateTextResult = Awaited<ReturnType<typeof generateText>>;

async function generateTextWithRetry(options: {
  request: GenerateTextRequest;
  phase: 'research' | 'writer';
  logger: StoryPipelineOptions['logger'];
}): Promise<GenerateTextResult> {
  const { request, phase, logger } = options;

  for (let attempt = 0; attempt <= MAX_LLM_RETRIES; attempt += 1) {
    const attemptNumber = attempt + 1;
    const startedAt = Date.now();

    try {
      const response = await generateText(request);
      logger?.info('story.llm.call.succeeded', {
        phase,
        attempt: attemptNumber,
        durationMs: Date.now() - startedAt
      });
      return response;
    } catch (error) {
      const details = describeStoryError(error);
      const canRetry = attempt < MAX_LLM_RETRIES && shouldRetryLlmCall(error);

      logger?.warn('story.llm.call.failed', {
        phase,
        attempt: attemptNumber,
        durationMs: Date.now() - startedAt,
        ...details,
        willRetry: canRetry
      });

      if (!canRetry) {
        throw normalizeLlmError(error);
      }

      const backoffMs = computeBackoffMs(attempt);
      logger?.info('story.llm.call.retry_scheduled', {
        phase,
        attempt: attemptNumber,
        backoffMs
      });
      await wait(backoffMs);
    }
  }

  throw new Error('openrouter_request_failed:unknown');
}

export async function runStoryPipeline(options: StoryPipelineOptions): Promise<StoryPipelineResult> {
  const { accessToken, threadId, fetchImpl, model = DEFAULT_MODEL } = options;
  const logger = (options.logger ?? NOOP_STORY_LOGGER).withContext({ threadId, model });
  const startedAt = Date.now();

  if (!threadId) {
    throw new Error('thread_id_required');
  }

  if (!accessToken) {
    throw new Error('gmail_access_token_missing');
  }

  if (!OPENROUTER_API_KEY) {
    throw new Error('openrouter_api_key_missing');
  }

  logger.info('story.pipeline.started', {
    maxResearchSteps: MAX_RESEARCH_STEPS,
    maxLlmRetries: MAX_LLM_RETRIES
  });

  try {
    const openrouter = createOpenRouter({
      apiKey: OPENROUTER_API_KEY,
      fetch: fetchImpl,
      extraBody: OPENROUTER_ZERO_RETENTION_DEFAULTS
    });

    const budget = createStoryResearchBudget();
    logger.info('story.pipeline.budget_initialized', budgetSnapshot(budget));

    const { tools, state } = createStoryToolRuntime({
      accessToken,
      selectedThreadId: threadId,
      fetchImpl,
      budget,
      logger
    });

    logger.info('story.pipeline.prefetch_selected_thread.started');
    state.selectedThread = await fetchSelectedThread(threadId, {
      accessToken,
      fetchImpl,
      budget,
      logger
    });
    logger.info('story.pipeline.prefetch_selected_thread.succeeded', {
      messageCount: state.selectedThread.messageCount,
      participantCount: state.selectedThread.participants.length
    });

    const research = await generateTextWithRetry({
      phase: 'research',
      logger,
      request: {
        model: openrouter(model),
        temperature: 0,
        system: STORY_RESEARCH_SYSTEM_PROMPT,
        prompt: buildStoryResearchPrompt(threadId),
        tools,
        stopWhen: stepCountIs(MAX_RESEARCH_STEPS)
      }
    });

    if (!state.selectedThread) {
      logger.warn('story.pipeline.selected_thread_missing_after_research', {
        researchSteps: research.steps?.length ?? 0
      });
      state.selectedThread = await fetchSelectedThread(threadId, {
        accessToken,
        fetchImpl,
        budget,
        logger
      });
    }

    const context = buildStoryResearchContext(state);
    logger.info('story.pipeline.research_completed', {
      researchSteps: research.steps?.length ?? 0,
      relatedThreads: context.relatedThreads.length,
      participantHistories: context.participantHistory.length,
      budget: budgetSnapshot(budget)
    });

    const narrative = await generateTextWithRetry({
      phase: 'writer',
      logger,
      request: {
        model: openrouter(model),
        temperature: 0.5,
        system: STORY_WRITER_SYSTEM_PROMPT,
        prompt: buildStoryWriterPrompt(context)
      }
    });

    const story = narrative.text.trim();
    if (!story) {
      throw new Error('story_generation_empty');
    }

    logger.info('story.pipeline.completed', {
      durationMs: Date.now() - startedAt,
      storyLength: story.length,
      researchSteps: research.steps?.length ?? 0
    });

    return {
      story,
      metadata: {
        threadId,
        model,
        research: {
          steps: research.steps?.length ?? 0,
          relatedThreads: context.relatedThreads.length,
          participantHistories: context.participantHistory.length
        }
      }
    };
  } catch (error) {
    logger.trackError('story.pipeline.failed', error, {
      durationMs: Date.now() - startedAt
    });
    throw error;
  }
}
