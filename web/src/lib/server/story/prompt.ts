import type { StoryResearchContext } from './types';

export const STORY_RESEARCH_SYSTEM_PROMPT = [
	'You are researching a Gmail thread before writing narrative prose.',
	'You must gather evidence using tools before drafting conclusions.',
	'Research for timeline, people, and outcome signals.',
	'Do not invent events that are not grounded in tool results.'
].join(' ');

export const STORY_WRITER_SYSTEM_PROMPT = [
	'You are a literary editor writing in third-person narrative prose.',
	'Write a cohesive story about people, progression, and outcome.',
	'Avoid mailbox UI language, bullet points, and references to tool execution.',
	'Do not quote personal data that is not present in the supplied context.'
].join(' ');

export function buildStoryResearchPrompt(threadId: string): string {
	return [
		'Research this selected Gmail thread and gather adjacent context before writing.',
		`Selected thread ID: ${threadId}`,
		'Use getSelectedThread first, then searchRelatedThreads and getParticipantHistory as needed.',
		'Stop once you can describe participants, narrative arc, and outcome with confidence.'
	].join('\n');
}

export function buildStoryWriterPrompt(context: StoryResearchContext): string {
	const compactContext = {
		selectedThread: {
			threadId: context.selectedThread.threadId,
			subject: context.selectedThread.subject,
			participants: context.selectedThread.participants,
			messageCount: context.selectedThread.messageCount,
			firstMessageAt: context.selectedThread.firstMessageAt,
			lastMessageAt: context.selectedThread.lastMessageAt,
			messages: context.selectedThread.messages
		},
		relatedThreads: context.relatedThreads.map((thread) => ({
			threadId: thread.threadId,
			subject: thread.subject,
			participants: thread.participants,
			messageCount: thread.messageCount,
			firstMessageAt: thread.firstMessageAt,
			lastMessageAt: thread.lastMessageAt,
			latestSnippet: thread.latestSnippet
		})),
		participantHistory: context.participantHistory.map((entry) => ({
			participant: entry.participant,
			threads: entry.threads.map((thread) => ({
				threadId: thread.threadId,
				subject: thread.subject,
				firstMessageAt: thread.firstMessageAt,
				lastMessageAt: thread.lastMessageAt,
				messageCount: thread.messageCount,
				latestSnippet: thread.latestSnippet
			}))
		}))
	};

	return [
		'Write one third-person narrative story from this Gmail research context.',
		'Requirements:',
		'- Include the key people and their relationship dynamics.',
		'- Show progression over time with concrete events.',
		'- End with the best-supported outcome or unresolved state.',
		'- Keep tone intimate and factual; no mailbox UI terms.',
		'',
		`Context JSON:\n${JSON.stringify(compactContext)}`
	].join('\n');
}
