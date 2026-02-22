import { tool } from 'ai';
import { z } from 'zod';
import {
	fetchSelectedThread,
	getParticipantHistory,
	searchRelatedThreads,
	createStoryResearchBudget
} from './gmail-research';
import { NOOP_STORY_LOGGER, describeStoryError, type StoryLogger } from './logging';
import type { StoryParticipantHistory, StoryResearchContext, StoryThreadResearch } from './types';

type StoryResearchBudget = ReturnType<typeof createStoryResearchBudget>;

type StoryToolContext = {
	accessToken: string;
	selectedThreadId: string;
	fetchImpl?: typeof fetch;
	budget: StoryResearchBudget;
	logger?: StoryLogger;
};

export type StoryToolState = {
	selectedThread: StoryThreadResearch | null;
	relatedThreads: Map<string, StoryThreadResearch>;
	participantHistory: Map<string, StoryParticipantHistory>;
};

function toKey(value: string): string {
	return value.trim().toLowerCase();
}

export function createStoryToolRuntime(context: StoryToolContext) {
	const logger = context.logger ?? NOOP_STORY_LOGGER;

	const state: StoryToolState = {
		selectedThread: null,
		relatedThreads: new Map(),
		participantHistory: new Map()
	};

	const tools = {
		getSelectedThread: tool({
			description: 'Fetch the full selected Gmail thread including message excerpts and participants.',
			inputSchema: z.object({
				threadId: z.string().min(1)
			}),
			execute: async ({ threadId }) => {
				if (state.selectedThread && state.selectedThread.threadId === threadId) {
					logger.info('story.tool.get_selected_thread.cache_hit', {
						messageCount: state.selectedThread.messageCount,
						participantCount: state.selectedThread.participants.length
					});
					return state.selectedThread;
				}

				const startedAt = Date.now();
				logger.info('story.tool.get_selected_thread.started');

				try {
					const thread = await fetchSelectedThread(threadId, {
						accessToken: context.accessToken,
						fetchImpl: context.fetchImpl,
						budget: context.budget,
						logger
					});

					state.selectedThread = thread;
					logger.info('story.tool.get_selected_thread.succeeded', {
						durationMs: Date.now() - startedAt,
						messageCount: thread.messageCount,
						participantCount: thread.participants.length
					});
					return thread;
				} catch (error) {
					logger.warn('story.tool.get_selected_thread.failed', {
						durationMs: Date.now() - startedAt,
						...describeStoryError(error)
					});
					throw error;
				}
			}
		}),
		searchRelatedThreads: tool({
			description:
				'Search related Gmail threads by participant and subject hints to expand context around the selected thread.',
			inputSchema: z.object({
				participantEmail: z.string().email().optional(),
				subjectHint: z.string().min(1).max(180).optional(),
				maxResults: z.number().int().min(1).max(6).optional()
			}),
			execute: async ({ participantEmail, subjectHint, maxResults }) => {
				const startedAt = Date.now();
				logger.info('story.tool.search_related_threads.started', {
					hasParticipant: Boolean(participantEmail),
					hasSubjectHint: Boolean(subjectHint),
					maxResults: maxResults ?? null
				});

				try {
					const threads = await searchRelatedThreads({
						accessToken: context.accessToken,
						fetchImpl: context.fetchImpl,
						budget: context.budget,
						selectedThreadId: context.selectedThreadId,
						participant: participantEmail,
						subjectHint,
						maxResults,
						logger
					});

					for (const thread of threads) {
						state.relatedThreads.set(thread.threadId, thread);
					}

					logger.info('story.tool.search_related_threads.succeeded', {
						durationMs: Date.now() - startedAt,
						threadCount: threads.length
					});

					return threads;
				} catch (error) {
					logger.warn('story.tool.search_related_threads.failed', {
						durationMs: Date.now() - startedAt,
						...describeStoryError(error)
					});
					throw error;
				}
			}
		}),
		getParticipantHistory: tool({
			description:
				'Fetch additional thread history for a participant email to understand relationship context and timeline.',
			inputSchema: z.object({
				participantEmail: z.string().email(),
				maxResults: z.number().int().min(1).max(6).optional()
			}),
			execute: async ({ participantEmail, maxResults }) => {
				const startedAt = Date.now();
				logger.info('story.tool.get_participant_history.started', {
					maxResults: maxResults ?? null
				});

				try {
					const threads = await getParticipantHistory({
						accessToken: context.accessToken,
						fetchImpl: context.fetchImpl,
						budget: context.budget,
						participant: participantEmail,
						excludeThreadId: context.selectedThreadId,
						maxResults,
						logger
					});

					state.participantHistory.set(toKey(participantEmail), {
						participant: participantEmail,
						threads
					});

					for (const thread of threads) {
						state.relatedThreads.set(thread.threadId, thread);
					}

					logger.info('story.tool.get_participant_history.succeeded', {
						durationMs: Date.now() - startedAt,
						threadCount: threads.length
					});

					return {
						participant: participantEmail,
						threads
					};
				} catch (error) {
					logger.warn('story.tool.get_participant_history.failed', {
						durationMs: Date.now() - startedAt,
						...describeStoryError(error)
					});
					throw error;
				}
			}
		})
	};

	return {
		tools,
		state
	};
}

export function buildStoryResearchContext(state: StoryToolState): StoryResearchContext {
	if (!state.selectedThread) {
		throw new Error('story_research_missing_selected_thread');
	}

	return {
		selectedThread: state.selectedThread,
		relatedThreads: [...state.relatedThreads.values()],
		participantHistory: [...state.participantHistory.values()]
	};
}
