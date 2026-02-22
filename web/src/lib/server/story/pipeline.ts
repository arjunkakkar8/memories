import { OPENROUTER_API_KEY } from '$env/static/private';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateText, stepCountIs } from 'ai';
import { buildStoryResearchPrompt, buildStoryWriterPrompt, STORY_RESEARCH_SYSTEM_PROMPT, STORY_WRITER_SYSTEM_PROMPT } from './prompt';
import { createStoryResearchBudget, fetchSelectedThread } from './gmail-research';
import { buildStoryResearchContext, createStoryToolRuntime } from './tools';
import type { StoryPipelineOptions, StoryPipelineResult } from './types';

const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
const MAX_RESEARCH_STEPS = 6;

export const OPENROUTER_ZERO_RETENTION_DEFAULTS = {
	provider: {
		allow_fallbacks: false,
		data_collection: 'deny'
	}
} as const;

export async function runStoryPipeline(options: StoryPipelineOptions): Promise<StoryPipelineResult> {
	const { accessToken, threadId, fetchImpl, model = DEFAULT_MODEL } = options;

	if (!threadId) {
		throw new Error('thread_id_required');
	}

	if (!accessToken) {
		throw new Error('gmail_access_token_missing');
	}

	if (!OPENROUTER_API_KEY) {
		throw new Error('openrouter_api_key_missing');
	}

	const openrouter = createOpenRouter({
		apiKey: OPENROUTER_API_KEY,
		fetch: fetchImpl,
		extraBody: OPENROUTER_ZERO_RETENTION_DEFAULTS
	});

	const budget = createStoryResearchBudget();
	const { tools, state } = createStoryToolRuntime({
		accessToken,
		selectedThreadId: threadId,
		fetchImpl,
		budget
	});

	const research = await generateText({
		model: openrouter(model),
		temperature: 0,
		system: STORY_RESEARCH_SYSTEM_PROMPT,
		prompt: buildStoryResearchPrompt(threadId),
		tools,
		stopWhen: stepCountIs(MAX_RESEARCH_STEPS)
	});

	if (!state.selectedThread) {
		state.selectedThread = await fetchSelectedThread(threadId, {
			accessToken,
			fetchImpl,
			budget
		});
	}

	const context = buildStoryResearchContext(state);

	const narrative = await generateText({
		model: openrouter(model),
		temperature: 0.5,
		system: STORY_WRITER_SYSTEM_PROMPT,
		prompt: buildStoryWriterPrompt(context)
	});

	const story = narrative.text.trim();
	if (!story) {
		throw new Error('story_generation_empty');
	}

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
}
