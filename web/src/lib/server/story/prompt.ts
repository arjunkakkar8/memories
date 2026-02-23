import type { StoryEffectiveExplorationSettings } from './config';
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
  const compactContext = {
    selectedThread: {
      threadId: context.selectedThread.threadId,
      subject: context.selectedThread.subject,
      participants: context.selectedThread.participants,
      messageCount: context.selectedThread.messageCount,
      firstMessageAt: context.selectedThread.firstMessageAt,
      lastMessageAt: context.selectedThread.lastMessageAt,
      messages: context.selectedThread.messages,
      provenance: context.selectedThread.provenance
    },
    relatedThreads: context.relatedThreads.map((thread) => ({
      threadId: thread.threadId,
      subject: thread.subject,
      participants: thread.participants,
      messageCount: thread.messageCount,
      firstMessageAt: thread.firstMessageAt,
      lastMessageAt: thread.lastMessageAt,
      latestSnippet: thread.latestSnippet,
      provenance: thread.provenance
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
    })),
    explorationSummary: context.explorationSummary
  };

  return [
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
    `Context JSON:\n${JSON.stringify(compactContext)}`
  ].join('\n');
}
