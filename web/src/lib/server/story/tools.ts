import { tool } from 'ai';
import { z } from 'zod';
import {
	createStoryResearchBudget,
	expandParticipantNetwork,
	fetchSelectedThread,
	getParticipantHistory,
	searchRelatedThreads,
	searchThreadsByConcept,
	searchThreadsByTimeWindow
} from './gmail-research';
import { NOOP_STORY_LOGGER, describeStoryError, type StoryLogger } from './logging';
import type { StoryEffectiveExplorationSettings } from './config';
import type {
	StoryParticipantHistory,
	StoryPipelineProgress,
	StoryResearchContext,
	StoryThreadProvenance,
	StoryThreadResearch
} from './types';

type StoryResearchBudget = ReturnType<typeof createStoryResearchBudget>;

type StoryToolContext = {
	accessToken: string;
	selectedThreadId: string;
	fetchImpl?: typeof fetch;
	budget: StoryResearchBudget;
	exploration: Pick<
		StoryEffectiveExplorationSettings,
		'searchPageSize' | 'searchMaxPages' | 'detailBatchSize'
	>;
	logger?: StoryLogger;
	onProgress?: (progress: StoryPipelineProgress) => void;
};

export type StoryToolState = {
	selectedThread: StoryThreadResearch | null;
	relatedThreads: Map<string, StoryThreadResearch>;
	participantHistory: Map<string, StoryParticipantHistory>;
};

function toKey(value: string): string {
	return value.trim().toLowerCase();
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

function mergeThreadResearch(
	current: StoryThreadResearch | undefined,
	incoming: StoryThreadResearch
): StoryThreadResearch {
	if (!current) {
		return incoming;
	}

	return {
		...current,
		historyId: incoming.historyId ?? current.historyId,
		subject: incoming.subject ?? current.subject,
		participants: [...new Set([...current.participants, ...incoming.participants])],
		messageCount: Math.max(current.messageCount, incoming.messageCount),
		firstMessageAt: current.firstMessageAt ?? incoming.firstMessageAt,
		lastMessageAt: incoming.lastMessageAt ?? current.lastMessageAt,
		latestSnippet: incoming.latestSnippet ?? current.latestSnippet,
		messages:
			current.messages.length >= incoming.messages.length ? current.messages : incoming.messages,
		provenance: mergeProvenance(current.provenance, incoming.provenance)
	};
}

export function createStoryToolRuntime(context: StoryToolContext) {
	const logger = context.logger ?? NOOP_STORY_LOGGER;

	const emitProgress = (stage: string, label: string, metadata?: Record<string, unknown>): void => {
		context.onProgress?.({
			stage,
			label,
			metadata,
			timestamp: new Date().toISOString()
		});
	};

	const state: StoryToolState = {
		selectedThread: null,
		relatedThreads: new Map(),
		participantHistory: new Map()
	};

	const ingestRelatedThreads = (threads: StoryThreadResearch[]): void => {
		for (const thread of threads) {
			state.relatedThreads.set(
				thread.threadId,
				mergeThreadResearch(state.relatedThreads.get(thread.threadId), thread)
			);
		}
	};

	const mergeParticipantHistory = (
		participantEmail: string,
		threads: StoryThreadResearch[]
	): void => {
		const key = toKey(participantEmail);
		const existing = state.participantHistory.get(key);
		const mergedById = new Map<string, StoryThreadResearch>();

		for (const thread of existing?.threads ?? []) {
			mergedById.set(thread.threadId, thread);
		}

		for (const thread of threads) {
			mergedById.set(thread.threadId, mergeThreadResearch(mergedById.get(thread.threadId), thread));
		}

		state.participantHistory.set(key, {
			participant: participantEmail,
			threads: [...mergedById.values()]
		});
	};

	const tools = {
		getSelectedThread: tool({
			description:
				'Fetch the full selected Gmail thread including message excerpts and participants.',
			inputSchema: z.object({
				threadId: z.string().min(1)
			}),
			execute: async ({ threadId }) => {
				if (state.selectedThread && state.selectedThread.threadId === threadId) {
					emitProgress('tool.getSelectedThread.completed', 'Retrieved selected email thread', {
						tool: 'getSelectedThread',
						cacheHit: true,
						messageCount: state.selectedThread.messageCount
					});
					logger.info('story.tool.get_selected_thread.cache_hit', {
						messageCount: state.selectedThread.messageCount,
						participantCount: state.selectedThread.participants.length
					});
					return state.selectedThread;
				}

				const startedAt = Date.now();
				emitProgress('tool.getSelectedThread.started', 'Retrieving selected email thread', {
					tool: 'getSelectedThread'
				});
				logger.info('story.tool.get_selected_thread.started');

				try {
					const thread = await fetchSelectedThread(threadId, {
						accessToken: context.accessToken,
						fetchImpl: context.fetchImpl,
						budget: context.budget,
						logger
					});

					state.selectedThread = thread;
					emitProgress('tool.getSelectedThread.completed', 'Retrieved selected email thread', {
						tool: 'getSelectedThread',
						durationMs: Date.now() - startedAt,
						messageCount: thread.messageCount,
						participantCount: thread.participants.length
					});
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
				maxResults: z.number().int().min(1).max(8).optional()
			}),
			execute: async ({ participantEmail, subjectHint, maxResults }) => {
				const startedAt = Date.now();
				emitProgress('tool.searchRelatedThreads.started', 'Finding related emails', {
					tool: 'searchRelatedThreads',
					hasParticipant: Boolean(participantEmail),
					hasSubjectHint: Boolean(subjectHint),
					maxResults: maxResults ?? null
				});
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
						logger,
						...context.exploration
					});

					ingestRelatedThreads(threads);

					emitProgress('tool.searchRelatedThreads.completed', 'Found related emails', {
						tool: 'searchRelatedThreads',
						durationMs: Date.now() - startedAt,
						threadCount: threads.length,
						source: 'search_related_threads'
					});

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
				maxResults: z.number().int().min(1).max(8).optional()
			}),
			execute: async ({ participantEmail, maxResults }) => {
				const startedAt = Date.now();
				emitProgress('tool.getParticipantHistory.started', 'Looking up participant history', {
					tool: 'getParticipantHistory',
					maxResults: maxResults ?? null
				});
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
						logger,
						...context.exploration
					});

					mergeParticipantHistory(participantEmail, threads);
					ingestRelatedThreads(threads);

					emitProgress('tool.getParticipantHistory.completed', 'Loaded participant history', {
						tool: 'getParticipantHistory',
						durationMs: Date.now() - startedAt,
						threadCount: threads.length,
						source: 'participant_history'
					});

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
		}),
		searchThreadsByConcept: tool({
			description:
				'Search Gmail threads by concept or keyword to broaden context around adjacent ideas.',
			inputSchema: z.object({
				concept: z.string().min(2).max(100),
				maxResults: z.number().int().min(1).max(8).optional()
			}),
			execute: async ({ concept, maxResults }) => {
				const startedAt = Date.now();
				emitProgress('tool.searchThreadsByConcept.started', 'Exploring concept neighborhood', {
					tool: 'searchThreadsByConcept',
					maxResults: maxResults ?? null
				});
				logger.info('story.tool.search_threads_by_concept.started', {
					maxResults: maxResults ?? null
				});

				try {
					const threads = await searchThreadsByConcept({
						accessToken: context.accessToken,
						fetchImpl: context.fetchImpl,
						budget: context.budget,
						selectedThreadId: context.selectedThreadId,
						concept,
						maxResults,
						logger,
						...context.exploration
					});

					ingestRelatedThreads(threads);

					emitProgress('tool.searchThreadsByConcept.completed', 'Concept exploration complete', {
						tool: 'searchThreadsByConcept',
						durationMs: Date.now() - startedAt,
						threadCount: threads.length,
						source: 'search_threads_by_concept'
					});

					return threads;
				} catch (error) {
					logger.warn('story.tool.search_threads_by_concept.failed', {
						durationMs: Date.now() - startedAt,
						...describeStoryError(error)
					});
					throw error;
				}
			}
		}),
		searchThreadsByTimeWindow: tool({
			description:
				'Search Gmail threads within a timeline window around important moments from the selected thread.',
			inputSchema: z.object({
				after: z.string().datetime().optional(),
				before: z.string().datetime().optional(),
				maxResults: z.number().int().min(1).max(8).optional()
			}),
			execute: async ({ after, before, maxResults }) => {
				const startedAt = Date.now();
				emitProgress(
					'tool.searchThreadsByTimeWindow.started',
					'Scanning timeline-adjacent threads',
					{
						tool: 'searchThreadsByTimeWindow',
						hasAfter: Boolean(after),
						hasBefore: Boolean(before),
						maxResults: maxResults ?? null
					}
				);

				try {
					const threads = await searchThreadsByTimeWindow({
						accessToken: context.accessToken,
						fetchImpl: context.fetchImpl,
						budget: context.budget,
						selectedThreadId: context.selectedThreadId,
						after,
						before,
						maxResults,
						logger,
						...context.exploration
					});

					ingestRelatedThreads(threads);

					emitProgress(
						'tool.searchThreadsByTimeWindow.completed',
						'Timeline exploration complete',
						{
							tool: 'searchThreadsByTimeWindow',
							durationMs: Date.now() - startedAt,
							threadCount: threads.length,
							source: 'search_threads_by_time_window'
						}
					);

					return threads;
				} catch (error) {
					logger.warn('story.tool.search_threads_by_time_window.failed', {
						durationMs: Date.now() - startedAt,
						...describeStoryError(error)
					});
					throw error;
				}
			}
		}),
		expandParticipantNetwork: tool({
			description:
				'Expand exploration from a participant to their nearby participant network and related threads.',
			inputSchema: z.object({
				participantEmail: z.string().email(),
				maxParticipants: z.number().int().min(1).max(5).optional(),
				maxResultsPerParticipant: z.number().int().min(1).max(6).optional()
			}),
			execute: async ({ participantEmail, maxParticipants, maxResultsPerParticipant }) => {
				const startedAt = Date.now();
				emitProgress('tool.expandParticipantNetwork.started', 'Expanding participant network', {
					tool: 'expandParticipantNetwork',
					maxParticipants: maxParticipants ?? null,
					maxResultsPerParticipant: maxResultsPerParticipant ?? null
				});

				try {
					const threads = await expandParticipantNetwork({
						accessToken: context.accessToken,
						fetchImpl: context.fetchImpl,
						budget: context.budget,
						selectedThreadId: context.selectedThreadId,
						participantEmail,
						maxParticipants,
						maxResultsPerParticipant,
						logger,
						...context.exploration
					});

					ingestRelatedThreads(threads);

					emitProgress('tool.expandParticipantNetwork.completed', 'Participant network expanded', {
						tool: 'expandParticipantNetwork',
						durationMs: Date.now() - startedAt,
						threadCount: threads.length,
						source: 'expand_participant_network'
					});

					return threads;
				} catch (error) {
					logger.warn('story.tool.expand_participant_network.failed', {
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
		state,
		ingestRelatedThreads,
		mergeParticipantHistory
	};
}

function countThreadsBySource(threads: StoryThreadResearch[]): {
	conceptThreadsFound: number;
	timelineThreadsFound: number;
	participantNetworkThreadsFound: number;
	provenanceCounts: Record<string, number>;
} {
	let conceptThreadsFound = 0;
	let timelineThreadsFound = 0;
	let participantNetworkThreadsFound = 0;
	const provenanceCounts: Record<string, number> = {};

	for (const thread of threads) {
		const seenSources = new Set(thread.provenance.map((entry) => entry.source));
		for (const source of seenSources) {
			provenanceCounts[source] = (provenanceCounts[source] ?? 0) + 1;
		}

		if (seenSources.has('search_threads_by_concept')) {
			conceptThreadsFound += 1;
		}

		if (seenSources.has('search_threads_by_time_window')) {
			timelineThreadsFound += 1;
		}

		if (seenSources.has('expand_participant_network')) {
			participantNetworkThreadsFound += 1;
		}
	}

	return {
		conceptThreadsFound,
		timelineThreadsFound,
		participantNetworkThreadsFound,
		provenanceCounts
	};
}

export function buildStoryResearchContext(state: StoryToolState): StoryResearchContext {
	if (!state.selectedThread) {
		throw new Error('story_research_missing_selected_thread');
	}

	const relatedThreads = [...state.relatedThreads.values()];
	const participantHistory = [...state.participantHistory.values()];
	const counts = countThreadsBySource(relatedThreads);

	return {
		selectedThread: state.selectedThread,
		relatedThreads,
		participantHistory,
		explorationSummary: {
			relatedThreadsDiscovered: relatedThreads.length,
			participantHistoriesLoaded: participantHistory.length,
			conceptThreadsFound: counts.conceptThreadsFound,
			timelineThreadsFound: counts.timelineThreadsFound,
			participantNetworkThreadsFound: counts.participantNetworkThreadsFound,
			provenanceCounts: counts.provenanceCounts
		}
	};
}
