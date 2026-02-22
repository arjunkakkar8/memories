import { tool } from 'ai';
import { z } from 'zod';
import {
	fetchSelectedThread,
	getParticipantHistory,
	searchRelatedThreads,
	createStoryResearchBudget
} from './gmail-research';
import type { StoryParticipantHistory, StoryResearchContext, StoryThreadResearch } from './types';

type StoryResearchBudget = ReturnType<typeof createStoryResearchBudget>;

type StoryToolContext = {
	accessToken: string;
	selectedThreadId: string;
	fetchImpl?: typeof fetch;
	budget: StoryResearchBudget;
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
				const thread = await fetchSelectedThread(threadId, {
					accessToken: context.accessToken,
					fetchImpl: context.fetchImpl,
					budget: context.budget
				});

				state.selectedThread = thread;
				return thread;
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
				const threads = await searchRelatedThreads({
					accessToken: context.accessToken,
					fetchImpl: context.fetchImpl,
					budget: context.budget,
					selectedThreadId: context.selectedThreadId,
					participant: participantEmail,
					subjectHint,
					maxResults
				});

				for (const thread of threads) {
					state.relatedThreads.set(thread.threadId, thread);
				}

				return threads;
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
				const threads = await getParticipantHistory({
					accessToken: context.accessToken,
					fetchImpl: context.fetchImpl,
					budget: context.budget,
					participant: participantEmail,
					excludeThreadId: context.selectedThreadId,
					maxResults
				});

				state.participantHistory.set(toKey(participantEmail), {
					participant: participantEmail,
					threads
				});

				for (const thread of threads) {
					state.relatedThreads.set(thread.threadId, thread);
				}

				return {
					participant: participantEmail,
					threads
				};
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
