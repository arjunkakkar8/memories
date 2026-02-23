import { OPENROUTER_API_KEY, OPENROUTER_MODEL } from '$env/static/private';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateText, stepCountIs, streamText } from 'ai';
import {
	buildStoryResearchPrompt,
	buildStoryWriterPrompt,
	STORY_RESEARCH_SYSTEM_PROMPT,
	STORY_WRITER_SYSTEM_PROMPT
} from './prompt';
import { createStoryResearchBudget, fetchSelectedThread } from './gmail-research';
import { NOOP_STORY_LOGGER, describeStoryError, parseStatusCode } from './logging';
import { buildStoryResearchContext, createStoryToolRuntime } from './tools';
import type {
	StoryPipelineOptions,
	StoryPipelineProgress,
	StoryPipelineResult,
	StoryPipelineToken
} from './types';

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

function budgetSnapshot(
	budget: ReturnType<typeof createStoryResearchBudget>
): Record<string, unknown> {
	if (typeof budget.snapshot === 'function') {
		return budget.snapshot() as Record<string, unknown>;
	}

	return {};
}

function emitProgress(
	onProgress: StoryPipelineOptions['onProgress'],
	stage: string,
	label: string,
	metadata?: Record<string, unknown>
): void {
	onProgress?.({
		stage,
		label,
		metadata,
		timestamp: new Date().toISOString()
	});
}

function emitToken(
	onToken: StoryPipelineOptions['onToken'],
	chunk: Omit<StoryPipelineToken, 'timestamp'>
): void {
	onToken?.({
		...chunk,
		timestamp: new Date().toISOString()
	});
}

type GenerateTextRequest = Parameters<typeof generateText>[0];
type GenerateTextResult = Awaited<ReturnType<typeof generateText>>;
type StreamTextRequest = Parameters<typeof streamText>[0];

async function generateTextWithRetry(options: {
	request: GenerateTextRequest;
	phase: 'research' | 'writer';
	logger: StoryPipelineOptions['logger'];
	onProgress?: StoryPipelineOptions['onProgress'];
}): Promise<GenerateTextResult> {
	const { request, phase, logger, onProgress } = options;

	for (let attempt = 0; attempt <= MAX_LLM_RETRIES; attempt += 1) {
		const attemptNumber = attempt + 1;
		const startedAt = Date.now();
		emitProgress(
			onProgress,
			`${phase}.attempt.started`,
			attemptNumber === 1
				? phase === 'research'
					? 'Researching email context'
					: 'Writing your story'
				: phase === 'research'
					? 'Retrying research step'
					: 'Retrying story draft',
			{
				phase,
				attempt: attemptNumber,
				maxAttempts: MAX_LLM_RETRIES + 1
			}
		);

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
			emitProgress(onProgress, `${phase}.retry.scheduled`, 'Scheduling retry', {
				phase,
				attempt: attemptNumber,
				backoffMs
			});
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

async function streamTextWithRetry(options: {
	request: StreamTextRequest;
	logger: StoryPipelineOptions['logger'];
	onProgress?: StoryPipelineOptions['onProgress'];
	onToken?: StoryPipelineOptions['onToken'];
}): Promise<string> {
	const { request, logger, onProgress, onToken } = options;

	for (let attempt = 0; attempt <= MAX_LLM_RETRIES; attempt += 1) {
		const attemptNumber = attempt + 1;
		const startedAt = Date.now();
		emitProgress(
			onProgress,
			'writer.attempt.started',
			attemptNumber === 1 ? 'Writing your story' : 'Retrying story draft',
			{
				phase: 'writer',
				attempt: attemptNumber,
				maxAttempts: MAX_LLM_RETRIES + 1
			}
		);

		try {
			const response = streamText(request);
			let tokenIndex = 0;

			for await (const token of response.textStream) {
				if (!token) {
					continue;
				}

				emitToken(onToken, {
					token,
					index: tokenIndex
				});
				tokenIndex += 1;
			}

			const text = await response.text;
			emitToken(onToken, {
				token: '',
				index: tokenIndex,
				isFinal: true
			});

			logger?.info('story.llm.stream.succeeded', {
				phase: 'writer',
				attempt: attemptNumber,
				durationMs: Date.now() - startedAt,
				tokenCount: tokenIndex
			});

			return text;
		} catch (error) {
			const details = describeStoryError(error);
			const canRetry = attempt < MAX_LLM_RETRIES && shouldRetryLlmCall(error);

			logger?.warn('story.llm.stream.failed', {
				phase: 'writer',
				attempt: attemptNumber,
				durationMs: Date.now() - startedAt,
				...details,
				willRetry: canRetry
			});

			if (!canRetry) {
				throw normalizeLlmError(error);
			}

			const backoffMs = computeBackoffMs(attempt);
			emitProgress(onProgress, 'writer.retry.scheduled', 'Scheduling retry', {
				phase: 'writer',
				attempt: attemptNumber,
				backoffMs
			});
			logger?.info('story.llm.stream.retry_scheduled', {
				phase: 'writer',
				attempt: attemptNumber,
				backoffMs
			});
			await wait(backoffMs);
		}
	}

	throw new Error('openrouter_request_failed:unknown');
}

export async function runStoryPipeline(
	options: StoryPipelineOptions
): Promise<StoryPipelineResult> {
	const {
		accessToken,
		threadId,
		fetchImpl,
		model = DEFAULT_MODEL,
		onProgress,
		onToken,
		streamWriterTokens = false
	} = options;
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
	emitProgress(onProgress, 'pipeline.started', 'Starting story generation', {
		model,
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
			logger,
			onProgress
		});

		logger.info('story.pipeline.prefetch_selected_thread.started');
		emitProgress(
			onProgress,
			'prefetch.selected_thread.started',
			'Retrieving selected email thread',
			{
				tool: 'getSelectedThread',
				prefetch: true
			}
		);
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
		emitProgress(
			onProgress,
			'prefetch.selected_thread.completed',
			'Retrieved selected email thread',
			{
				tool: 'getSelectedThread',
				prefetch: true,
				messageCount: state.selectedThread.messageCount,
				participantCount: state.selectedThread.participants.length
			}
		);

		emitProgress(onProgress, 'research.started', 'Researching email context', {
			model
		});

		const research = await generateTextWithRetry({
			phase: 'research',
			logger,
			onProgress,
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
		emitProgress(onProgress, 'research.completed', 'Finished research', {
			researchSteps: research.steps?.length ?? 0,
			relatedThreads: context.relatedThreads.length,
			participantHistories: context.participantHistory.length
		});

		emitProgress(onProgress, 'writer.started', 'Writing your story', {
			model,
			streaming: streamWriterTokens
		});

		const writerRequest: GenerateTextRequest = {
			model: openrouter(model),
			temperature: 0.5,
			system: STORY_WRITER_SYSTEM_PROMPT,
			prompt: buildStoryWriterPrompt(context)
		};

		const storyDraft = streamWriterTokens
			? await streamTextWithRetry({
					request: writerRequest,
					logger,
					onProgress,
					onToken
				})
			: (
					await generateTextWithRetry({
						phase: 'writer',
						logger,
						onProgress,
						request: writerRequest
					})
				).text;

		const story = storyDraft.trim();
		if (!story) {
			throw new Error('story_generation_empty');
		}
		emitProgress(onProgress, 'writer.completed', 'Story draft complete', {
			storyLength: story.length
		});

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
