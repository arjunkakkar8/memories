import { STORY_WRITER_MAX_PROMPT_TOKENS, type StoryEffectiveExplorationSettings } from './config';
import type { StoryResearchContext, StoryViewerContext } from './types';

export const STORY_RESEARCH_SYSTEM_PROMPT = [
	'You are researching a Gmail thread before writing narrative prose.',
	'You must gather evidence using tools before drafting conclusions and satisfy breadth coverage.',
	'Research must include selected-thread detail, related threads, participant network context, concept neighborhoods, and timeline-adjacent threads.',
	'Search for key people, events and ideas across the email history to build appropriate context.',
	'Do not invent events that are not grounded in tool results.'
].join(' ');

export const STORY_WRITER_SYSTEM_PROMPT = [
	'You are a literary editor writing evidence-grounded narrative in Markdown. Your goal is to recount the memory and time period associated with the researched content.',
	'Write in personalized second-person voice by default so the signed-in reader feels directly addressed.',
	'Use only facts grounded in supplied context; do not invent events or external details.',
	'Avoid mailbox UI language and references to tool execution.',
	'Steer clear of making the narrative sound like a list of events.'
].join(' ');

export function buildStoryResearchPrompt(options: {
	threadId: string;
	exploration: Pick<
		StoryEffectiveExplorationSettings,
		| 'profile'
		| 'maxResearchSteps'
		| 'minRelatedThreads'
		| 'minParticipantHistories'
		| 'minConceptThreads'
	>;
	hints?: {
		subject?: string;
		participants?: string[];
	};
}): string {
	const hintParticipants = options.hints?.participants?.filter(Boolean).slice(0, 8) ?? [];
	const hintSubject = options.hints?.subject?.trim() ?? '';

	return [
		'Research this selected Gmail thread and gather adjacent context before writing.',
		`Selected thread ID: ${options.threadId}`,
		`Exploration profile: ${options.exploration.profile}`,
		`Maximum research steps: ${options.exploration.maxResearchSteps}`,
		`Coverage minimums: related threads >= ${options.exploration.minRelatedThreads}, participant histories >= ${options.exploration.minParticipantHistories}, concept threads >= ${options.exploration.minConceptThreads}`,
		'Use getSelectedThread first.',
		'Then broaden with searchRelatedThreads, getParticipantHistory, searchThreadsByConcept, searchThreadsByTimeWindow, and expandParticipantNetwork.',
		'Extract important ideas and phrases from the researched threads to explore further.',
		'Keep using searchThreadsByConcept with these ideas and phrases to expand research coverage.',
		'End with exploring future conversations with the same participants to see how the thread evolves.',
		hintSubject ? `Optional subject hint: ${hintSubject}` : 'Optional subject hint: (none)',
		hintParticipants.length > 0
			? `Optional participant hints: ${hintParticipants.join(', ')}`
			: 'Optional participant hints: (none)'
	].join('\n');
}

export function buildStoryWriterPrompt(options: {
	context: StoryResearchContext;
	viewerContext?: StoryViewerContext;
}): string {
	const { context, viewerContext } = options;
	const normalizeText = (value: string | null | undefined): string =>
		(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
	const estimateTokens = (value: string): number => Math.ceil(value.length / 4);

	const dedupeBySignature = <T>(items: T[], signatureFor: (item: T) => string): T[] => {
		const seen = new Set<string>();
		const deduped: T[] = [];
		for (const item of items) {
			const signature = signatureFor(item);
			if (seen.has(signature)) {
				continue;
			}
			seen.add(signature);
			deduped.push(item);
		}
		return deduped;
	};

	const selectedThreadMessages = dedupeBySignature(context.selectedThread.messages, (message) =>
		[
			message.messageId,
			message.sentAt,
			normalizeText(message.from),
			normalizeText(message.subject),
			normalizeText(message.excerpt)
		].join('|')
	).map((message) => ({
		sentAt: message.sentAt,
		from: message.from,
		subject: message.subject,
		excerpt: message.excerpt
	}));

	const relatedThreads = dedupeBySignature(
		context.relatedThreads.slice().sort((left, right) => {
			const leftTs = Date.parse(left.lastMessageAt ?? '') || 0;
			const rightTs = Date.parse(right.lastMessageAt ?? '') || 0;
			return rightTs - leftTs;
		}),
		(thread) =>
			[
				thread.threadId,
				normalizeText(thread.subject),
				thread.messageCount,
				thread.firstMessageAt,
				thread.lastMessageAt,
				normalizeText(thread.latestSnippet),
				thread.participants.map(normalizeText).sort().join(',')
			].join('|')
	).map((thread) => ({
		threadId: thread.threadId,
		subject: thread.subject,
		participants: thread.participants,
		messageCount: thread.messageCount,
		firstMessageAt: thread.firstMessageAt,
		lastMessageAt: thread.lastMessageAt,
		latestSnippet: thread.latestSnippet,
		provenance: thread.provenance
	}));

	const relatedThreadIds = new Set(relatedThreads.map((thread) => thread.threadId));
	const participantHistory = dedupeBySignature(
		context.participantHistory.map((entry) => ({
			participant: entry.participant,
			threadRefs: dedupeBySignature(
				entry.threads
					.filter((thread) => !relatedThreadIds.has(thread.threadId))
					.map((thread) => ({
						threadId: thread.threadId,
						subject: thread.subject,
						lastMessageAt: thread.lastMessageAt
					})),
				(thread) => [thread.threadId, normalizeText(thread.subject), thread.lastMessageAt].join('|')
			)
		})),
		(entry) =>
			[
				normalizeText(entry.participant),
				entry.threadRefs
					.map(
						(thread) =>
							`${thread.threadId}:${normalizeText(thread.subject)}:${thread.lastMessageAt ?? ''}`
					)
					.join(',')
			].join('|')
	).filter((entry) => entry.threadRefs.length > 0);

	const compactContext = {
		selectedThread: {
			threadId: context.selectedThread.threadId,
			subject: context.selectedThread.subject,
			participants: context.selectedThread.participants,
			messageCount: context.selectedThread.messageCount,
			firstMessageAt: context.selectedThread.firstMessageAt,
			lastMessageAt: context.selectedThread.lastMessageAt,
			messages: selectedThreadMessages,
			provenance: context.selectedThread.provenance
		},
		relatedThreads,
		participantHistory,
		explorationSummary: context.explorationSummary
	};

	const promptPrefix = [
		'Write a narrative driven Markdown story from this research context. This story should read like recalling a personal memory.',
		'Requirements:',
		'- Begin with an H1 title.',
		'- Use 2-4 H2 sections with narrative paragraphs (not bullet dumps).',
		'- Personalize the voice to the signed-in user in second-person by default.',
		'- Ensure that the story covers the full arc of the engagement, including relevant historical context.',
		'- Include key people, relationship dynamics, and progression over time with concrete events.',
		'- End with the best-supported outcome or unresolved state.',
		'- Keep tone intimate and factual; no mailbox UI terms.',
		'- Do not include facts that are not grounded in context.',
		'- Make sure it reads like recalling a personal memory.',
		'',
		`Viewer context JSON:\n${JSON.stringify(viewerContext ?? null)}`,
		'',
		'Context JSON:\n'
	].join('\n');

	const promptTokenBudgetForContext = Math.max(
		1,
		STORY_WRITER_MAX_PROMPT_TOKENS - estimateTokens(promptPrefix)
	);

	const mutableContext = structuredClone(compactContext) as typeof compactContext & {
		truncatedForBudget?: boolean;
	};

	const serializeContext = (): string => JSON.stringify(mutableContext);
	const contextWithinBudget = (): boolean =>
		estimateTokens(serializeContext()) <= promptTokenBudgetForContext;

	const stripLongestMessageExcerpt = (): boolean => {
		let longestIndex = -1;
		let longestLength = 0;
		for (let index = 0; index < mutableContext.selectedThread.messages.length; index += 1) {
			const excerpt = mutableContext.selectedThread.messages[index]?.excerpt;
			const length = excerpt?.length ?? 0;
			if (length > longestLength) {
				longestLength = length;
				longestIndex = index;
			}
		}

		if (longestIndex === -1 || longestLength === 0) {
			return false;
		}

		mutableContext.selectedThread.messages[longestIndex] = {
			...mutableContext.selectedThread.messages[longestIndex],
			excerpt: null
		};
		return true;
	};

	const stripLongestSnippet = (): boolean => {
		let longestIndex = -1;
		let longestLength = 0;
		for (let index = 0; index < mutableContext.relatedThreads.length; index += 1) {
			const snippet = mutableContext.relatedThreads[index]?.latestSnippet;
			const length = snippet?.length ?? 0;
			if (length > longestLength) {
				longestLength = length;
				longestIndex = index;
			}
		}

		if (longestIndex === -1 || longestLength === 0) {
			return false;
		}

		mutableContext.relatedThreads[longestIndex] = {
			...mutableContext.relatedThreads[longestIndex],
			latestSnippet: null
		};
		return true;
	};

	const dropParticipantHistoryTail = (): boolean => {
		if (mutableContext.participantHistory.length === 0) {
			return false;
		}

		for (let index = mutableContext.participantHistory.length - 1; index >= 0; index -= 1) {
			const entry = mutableContext.participantHistory[index];
			if (entry.threadRefs.length > 0) {
				entry.threadRefs.pop();
				if (entry.threadRefs.length === 0) {
					mutableContext.participantHistory.splice(index, 1);
				}
				return true;
			}
		}

		mutableContext.participantHistory.pop();
		return true;
	};

	const dropRelatedThreadTail = (): boolean => {
		if (mutableContext.relatedThreads.length === 0) {
			return false;
		}

		mutableContext.relatedThreads.pop();
		return true;
	};

	const dropSelectedMessageTail = (): boolean => {
		if (mutableContext.selectedThread.messages.length === 0) {
			return false;
		}

		mutableContext.selectedThread.messages.pop();
		return true;
	};

	while (!contextWithinBudget()) {
		const changed =
			stripLongestMessageExcerpt() ||
			stripLongestSnippet() ||
			dropParticipantHistoryTail() ||
			dropRelatedThreadTail() ||
			dropSelectedMessageTail();

		if (!changed) {
			break;
		}

		mutableContext.truncatedForBudget = true;
	}

	const contextJson = serializeContext();

	return `${promptPrefix}${contextJson}`;
}
