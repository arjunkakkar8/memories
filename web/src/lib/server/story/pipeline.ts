import { OPENROUTER_API_KEY, OPENROUTER_MODEL } from '$env/static/private';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateText, stepCountIs, streamText } from 'ai';
import {
	buildStoryResearchPrompt,
	buildStoryWriterPrompt,
	STORY_RESEARCH_SYSTEM_PROMPT,
	STORY_WRITER_SYSTEM_PROMPT
} from './prompt';
import {
	createStoryResearchBudget,
	expandParticipantNetwork,
	fetchSelectedThread,
	getParticipantHistory,
	searchRelatedThreads,
	searchThreadsByConcept,
	searchThreadsByTimeWindow
} from './gmail-research';
import { NOOP_STORY_LOGGER, describeStoryError, parseStatusCode } from './logging';
import { buildStoryResearchContext, createStoryToolRuntime } from './tools';
import {
	resolveStoryExplorationSettings,
	STORY_CONCEPT_HINT_LIMIT,
	STORY_DEFAULT_MODEL,
	STORY_LLM_BACKOFF_BASE_MS,
	STORY_LLM_BACKOFF_JITTER_MAX_MS,
	STORY_LLM_BACKOFF_MAX_MS,
	STORY_MAX_LLM_RETRIES,
	STORY_NETWORK_FALLBACK_PARTICIPANTS,
	STORY_NETWORK_FALLBACK_RESULTS_PER_PARTICIPANT,
	STORY_OPENROUTER_ZERO_RETENTION_DEFAULTS,
	STORY_PARTICIPANT_HISTORY_FALLBACK_RESULTS,
	STORY_SEARCH_MIN_RESULTS_FALLBACK,
	STORY_SEED_PARTICIPANTS_LIMIT,
	STORY_SELECTED_MESSAGES_FOR_HINTS,
	STORY_STOPWORDS,
	STORY_TIMELINE_FALLBACK_RESULTS,
	STORY_TIMELINE_FALLBACK_WINDOW_DAYS,
	STORY_TOKEN_PATTERN,
	type StoryEffectiveExplorationSettings
} from './config';
import type {
	StoryPipelineOptions,
	StoryPipelineResult,
	StoryPipelineToken,
	StoryResearchContext,
	StoryThreadResearch
} from './types';

const DEFAULT_MODEL = OPENROUTER_MODEL || STORY_DEFAULT_MODEL;

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoffMs(attempt: number): number {
	const jitter = Math.floor(Math.random() * STORY_LLM_BACKOFF_JITTER_MAX_MS);
	return Math.min(STORY_LLM_BACKOFF_MAX_MS, STORY_LLM_BACKOFF_BASE_MS * 2 ** attempt + jitter);
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

function coverageDeficits(
	context: StoryResearchContext,
	settings: Pick<
		StoryEffectiveExplorationSettings,
		'minRelatedThreads' | 'minParticipantHistories' | 'minConceptThreads'
	>
): {
	related: number;
	participantHistories: number;
	concept: number;
} {
	return {
		related: Math.max(0, settings.minRelatedThreads - context.relatedThreads.length),
		participantHistories: Math.max(
			0,
			settings.minParticipantHistories - context.participantHistory.length
		),
		concept: Math.max(
			0,
			settings.minConceptThreads - context.explorationSummary.conceptThreadsFound
		)
	};
}

function shiftIsoDate(value: string | null, days: number): string | null {
	if (!value) {
		return null;
	}

	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		return null;
	}

	parsed.setUTCDate(parsed.getUTCDate() + days);
	return parsed.toISOString();
}

function sanitizeSeedParticipants(participants: string[] | undefined): string[] {
	const deduped = new Set<string>();
	for (const entry of participants ?? []) {
		const normalized = entry.trim().toLowerCase();
		if (normalized && normalized.includes('@')) {
			deduped.add(normalized);
		}
	}

	return [...deduped].slice(0, STORY_SEED_PARTICIPANTS_LIMIT);
}

function extractConceptTokens(text: string): string[] {
	const tokenMatches = text.toLowerCase().match(STORY_TOKEN_PATTERN) ?? [];
	const deduped: string[] = [];
	const seen = new Set<string>();

	for (const token of tokenMatches) {
		if (STORY_STOPWORDS.has(token)) {
			continue;
		}
		if (!seen.has(token)) {
			seen.add(token);
			deduped.push(token);
		}
	}

	return deduped;
}

function deriveConceptHints(context: StoryResearchContext, hintSubject?: string): string[] {
	const tokens: string[] = [];
	if (hintSubject) {
		tokens.push(...extractConceptTokens(hintSubject));
	}

	if (context.selectedThread.subject) {
		tokens.push(...extractConceptTokens(context.selectedThread.subject));
	}

	for (const message of context.selectedThread.messages.slice(0, 3)) {
		if (message.excerpt) {
			tokens.push(...extractConceptTokens(message.excerpt));
		}
	}

	const deduped = new Set(tokens);
	return [...deduped].slice(0, STORY_CONCEPT_HINT_LIMIT);
}

async function generateTextWithRetry(options: {
	request: GenerateTextRequest;
	phase: 'research' | 'writer';
	logger: StoryPipelineOptions['logger'];
	onProgress?: StoryPipelineOptions['onProgress'];
}): Promise<GenerateTextResult> {
	const { request, phase, logger, onProgress } = options;

	for (let attempt = 0; attempt <= STORY_MAX_LLM_RETRIES; attempt += 1) {
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
				maxAttempts: STORY_MAX_LLM_RETRIES + 1
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
			const canRetry = attempt < STORY_MAX_LLM_RETRIES && shouldRetryLlmCall(error);

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

	for (let attempt = 0; attempt <= STORY_MAX_LLM_RETRIES; attempt += 1) {
		const attemptNumber = attempt + 1;
		const startedAt = Date.now();
		emitProgress(
			onProgress,
			'writer.attempt.started',
			attemptNumber === 1 ? 'Writing your story' : 'Retrying story draft',
			{
				phase: 'writer',
				attempt: attemptNumber,
				maxAttempts: STORY_MAX_LLM_RETRIES + 1
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
			const canRetry = attempt < STORY_MAX_LLM_RETRIES && shouldRetryLlmCall(error);

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

async function runDeterministicCoverageFallback(options: {
	threadId: string;
	accessToken: string;
	fetchImpl?: typeof fetch;
	budget: ReturnType<typeof createStoryResearchBudget>;
	logger: StoryPipelineOptions['logger'];
	onProgress?: StoryPipelineOptions['onProgress'];
	settings: StoryEffectiveExplorationSettings;
	state: ReturnType<typeof createStoryToolRuntime>['state'];
	ingestRelatedThreads: (threads: StoryThreadResearch[]) => void;
	mergeParticipantHistory: (participantEmail: string, threads: StoryThreadResearch[]) => void;
	hints?: {
		subject?: string;
		participants?: string[];
	};
}): Promise<StoryResearchContext> {
	const {
		threadId,
		accessToken,
		fetchImpl,
		budget,
		logger,
		onProgress,
		settings,
		state,
		ingestRelatedThreads,
		mergeParticipantHistory,
		hints
	} = options;

	const sharedResearchOptions = {
		accessToken,
		fetchImpl,
		budget,
		logger,
		searchPageSize: settings.searchPageSize,
		searchMaxPages: settings.searchMaxPages,
		detailBatchSize: settings.detailBatchSize
	};

	const seedParticipants = [
		...sanitizeSeedParticipants(hints?.participants),
		...sanitizeSeedParticipants(state.selectedThread?.participants)
	].slice(0, STORY_SEED_PARTICIPANTS_LIMIT);
	const seedSubject = hints?.subject?.trim() || state.selectedThread?.subject || undefined;

	let context = buildStoryResearchContext(state);
	let deficits = coverageDeficits(context, settings);

	if (deficits.related > 0 && seedSubject) {
		const threads = await searchRelatedThreads({
			...sharedResearchOptions,
			selectedThreadId: threadId,
			subjectHint: seedSubject,
			maxResults: Math.max(deficits.related, STORY_SEARCH_MIN_RESULTS_FALLBACK)
		});
		ingestRelatedThreads(threads);
		context = buildStoryResearchContext(state);
		deficits = coverageDeficits(context, settings);
	}

	if (deficits.related > 0) {
		for (const participant of seedParticipants) {
			if (deficits.related <= 0) {
				break;
			}

			const threads = await searchRelatedThreads({
				...sharedResearchOptions,
				selectedThreadId: threadId,
				participant,
				maxResults: Math.max(deficits.related, STORY_SEARCH_MIN_RESULTS_FALLBACK)
			});
			ingestRelatedThreads(threads);
			context = buildStoryResearchContext(state);
			deficits = coverageDeficits(context, settings);
		}
	}

	if (deficits.participantHistories > 0) {
		for (const participant of seedParticipants) {
			if (deficits.participantHistories <= 0) {
				break;
			}

			const historyThreads = await getParticipantHistory({
				...sharedResearchOptions,
				participant,
				excludeThreadId: threadId,
				maxResults: STORY_PARTICIPANT_HISTORY_FALLBACK_RESULTS
			});
			mergeParticipantHistory(participant, historyThreads);
			ingestRelatedThreads(historyThreads);
			context = buildStoryResearchContext(state);
			deficits = coverageDeficits(context, settings);
		}
	}

	if (context.selectedThread.firstMessageAt || context.selectedThread.lastMessageAt) {
		const timelineThreads = await searchThreadsByTimeWindow({
			...sharedResearchOptions,
			selectedThreadId: threadId,
			after: shiftIsoDate(
				context.selectedThread.firstMessageAt,
				-STORY_TIMELINE_FALLBACK_WINDOW_DAYS
			),
			before: shiftIsoDate(
				context.selectedThread.lastMessageAt,
				STORY_TIMELINE_FALLBACK_WINDOW_DAYS
			),
			maxResults: STORY_TIMELINE_FALLBACK_RESULTS
		});
		ingestRelatedThreads(timelineThreads);
		context = buildStoryResearchContext(state);
		deficits = coverageDeficits(context, settings);
	}

	if (seedParticipants.length > 0) {
		const networkThreads = await expandParticipantNetwork({
			...sharedResearchOptions,
			selectedThreadId: threadId,
			participantEmail: seedParticipants[0],
			maxParticipants: STORY_NETWORK_FALLBACK_PARTICIPANTS,
			maxResultsPerParticipant: STORY_NETWORK_FALLBACK_RESULTS_PER_PARTICIPANT
		});
		ingestRelatedThreads(networkThreads);
		context = buildStoryResearchContext(state);
		deficits = coverageDeficits(context, settings);
	}

	if (deficits.concept > 0) {
		const concepts = deriveConceptHints(context, hints?.subject);
		for (const concept of concepts) {
			if (deficits.concept <= 0) {
				break;
			}

			const conceptThreads = await searchThreadsByConcept({
				...sharedResearchOptions,
				selectedThreadId: threadId,
				concept,
				maxResults: Math.max(deficits.concept, STORY_SEARCH_MIN_RESULTS_FALLBACK)
			});
			ingestRelatedThreads(conceptThreads);
			context = buildStoryResearchContext(state);
			deficits = coverageDeficits(context, settings);
		}
	}

	logger?.info('story.pipeline.coverage_fallback.completed', {
		deficits,
		relatedThreads: context.relatedThreads.length,
		participantHistories: context.participantHistory.length,
		conceptThreads: context.explorationSummary.conceptThreadsFound
	});

	emitProgress(onProgress, 'research.coverage.fallback.completed', 'Coverage fallback complete', {
		relatedThreads: context.relatedThreads.length,
		participantHistories: context.participantHistory.length,
		conceptThreads: context.explorationSummary.conceptThreadsFound,
		timelineThreads: context.explorationSummary.timelineThreadsFound,
		participantNetworkThreads: context.explorationSummary.participantNetworkThreadsFound
	});

	return context;
}

export async function runStoryPipeline(
	options: StoryPipelineOptions
): Promise<StoryPipelineResult> {
	const {
		accessToken,
		threadId,
		exploration,
		viewerContext,
		fetchImpl,
		model = DEFAULT_MODEL,
		onProgress,
		onToken,
		streamWriterTokens = false
	} = options;
	const explorationSettings = resolveStoryExplorationSettings(exploration);
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
		profile: explorationSettings.profile,
		maxResearchSteps: explorationSettings.maxResearchSteps,
		maxLlmRetries: STORY_MAX_LLM_RETRIES
	});
	emitProgress(onProgress, 'pipeline.started', 'Starting story generation', {
		model,
		profile: explorationSettings.profile,
		maxResearchSteps: explorationSettings.maxResearchSteps,
		maxLlmRetries: STORY_MAX_LLM_RETRIES,
		minRelatedThreads: explorationSettings.minRelatedThreads,
		minParticipantHistories: explorationSettings.minParticipantHistories,
		minConceptThreads: explorationSettings.minConceptThreads
	});

	try {
		const openrouter = createOpenRouter({
			apiKey: OPENROUTER_API_KEY,
			fetch: fetchImpl,
			extraBody: STORY_OPENROUTER_ZERO_RETENTION_DEFAULTS
		});

		const budget = createStoryResearchBudget({
			maxGmailUnits: explorationSettings.maxGmailUnits,
			maxConcurrentGmail: explorationSettings.maxConcurrentGmail,
			maxConcurrentLlm: 1
		});
		logger.info('story.pipeline.budget_initialized', {
			profile: explorationSettings.profile,
			maxGmailUnits: explorationSettings.maxGmailUnits,
			maxConcurrentGmail: explorationSettings.maxConcurrentGmail,
			...budgetSnapshot(budget)
		});

		const { tools, state, ingestRelatedThreads, mergeParticipantHistory } = createStoryToolRuntime({
			accessToken,
			selectedThreadId: threadId,
			fetchImpl,
			budget,
			exploration: {
				searchPageSize: explorationSettings.searchPageSize,
				searchMaxPages: explorationSettings.searchMaxPages,
				detailBatchSize: explorationSettings.detailBatchSize
			},
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
			model,
			profile: explorationSettings.profile
		});

		const research = await generateTextWithRetry({
			phase: 'research',
			logger,
			onProgress,
			request: {
				model: openrouter(model),
				temperature: 0,
				system: STORY_RESEARCH_SYSTEM_PROMPT,
				prompt: buildStoryResearchPrompt({
					threadId,
					exploration: explorationSettings,
					hints: exploration?.hints
				}),
				tools,
				stopWhen: stepCountIs(explorationSettings.maxResearchSteps)
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

		let context = buildStoryResearchContext(state);
		let deficits = coverageDeficits(context, explorationSettings);
		if (deficits.related > 0 || deficits.participantHistories > 0 || deficits.concept > 0) {
			emitProgress(onProgress, 'research.coverage.fallback.started', 'Expanding context coverage', {
				missingRelatedThreads: deficits.related,
				missingParticipantHistories: deficits.participantHistories,
				missingConceptThreads: deficits.concept
			});

			context = await runDeterministicCoverageFallback({
				threadId,
				accessToken,
				fetchImpl,
				budget,
				logger,
				onProgress,
				settings: explorationSettings,
				state,
				ingestRelatedThreads,
				mergeParticipantHistory,
				hints: exploration?.hints
			});

			deficits = coverageDeficits(context, explorationSettings);
			logger.info('story.pipeline.coverage_post_fallback', {
				deficits
			});
		}

		logger.info('story.pipeline.research_completed', {
			researchSteps: research.steps?.length ?? 0,
			relatedThreads: context.relatedThreads.length,
			participantHistories: context.participantHistory.length,
			conceptThreads: context.explorationSummary.conceptThreadsFound,
			timelineThreads: context.explorationSummary.timelineThreadsFound,
			participantNetworkThreads: context.explorationSummary.participantNetworkThreadsFound,
			budget: budgetSnapshot(budget),
			profile: explorationSettings.profile
		});
		emitProgress(onProgress, 'research.completed', 'Finished research', {
			researchSteps: research.steps?.length ?? 0,
			relatedThreads: context.relatedThreads.length,
			participantHistories: context.participantHistory.length,
			conceptThreads: context.explorationSummary.conceptThreadsFound,
			timelineThreads: context.explorationSummary.timelineThreadsFound,
			participantNetworkThreads: context.explorationSummary.participantNetworkThreadsFound
		});

		emitProgress(onProgress, 'writer.started', 'Writing your story', {
			model,
			streaming: streamWriterTokens,
			format: 'markdown'
		});

		const writerRequest: GenerateTextRequest = {
			model: openrouter(model),
			temperature: 0.5,
			system: STORY_WRITER_SYSTEM_PROMPT,
			prompt: buildStoryWriterPrompt({
				context,
				viewerContext
			})
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
			storyLength: story.length,
			format: 'markdown'
		});

		logger.info('story.pipeline.completed', {
			durationMs: Date.now() - startedAt,
			storyLength: story.length,
			researchSteps: research.steps?.length ?? 0,
			profile: explorationSettings.profile
		});

		return {
			story,
			metadata: {
				threadId,
				model,
				format: 'markdown',
				research: {
					steps: research.steps?.length ?? 0,
					relatedThreads: context.relatedThreads.length,
					participantHistories: context.participantHistory.length
				},
				exploration: {
					profile: explorationSettings.profile,
					maxResearchSteps: explorationSettings.maxResearchSteps,
					minRelatedThreads: explorationSettings.minRelatedThreads,
					minParticipantHistories: explorationSettings.minParticipantHistories,
					minConceptThreads: explorationSettings.minConceptThreads,
					relatedThreadsDiscovered: context.explorationSummary.relatedThreadsDiscovered,
					participantHistoriesLoaded: context.explorationSummary.participantHistoriesLoaded,
					conceptThreadsFound: context.explorationSummary.conceptThreadsFound,
					timelineThreadsFound: context.explorationSummary.timelineThreadsFound,
					participantNetworkThreadsFound: context.explorationSummary.participantNetworkThreadsFound,
					totalThreadsInContext: context.relatedThreads.length + 1
				}
			}
		};
	} catch (error) {
		logger.trackError('story.pipeline.failed', error, {
			durationMs: Date.now() - startedAt,
			profile: explorationSettings.profile
		});
		throw error;
	}
}
