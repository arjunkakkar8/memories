import { OPENROUTER_API_KEY, OPENROUTER_MODEL } from '$env/static/private';
import type { HeuristicCandidate, LlmCandidateScore } from './types';
import type { QuotaBudget } from './quota-budget';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = OPENROUTER_MODEL || 'openai/gpt-4o-mini';

type OpenRouterResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

type ScoreBatchOptions = {
  budget: QuotaBudget;
  fetchImpl?: typeof fetch;
  apiKey?: string;
  model?: string;
};

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

function parseBatchScores(content: string): LlmCandidateScore[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('openrouter_response_not_json');
  }

  if (!parsed || typeof parsed !== 'object' || !('scores' in parsed) || !Array.isArray(parsed.scores)) {
    throw new Error('openrouter_response_missing_scores');
  }

  return parsed.scores
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }

      const threadId = 'threadId' in entry && typeof entry.threadId === 'string' ? entry.threadId : '';
      const score = 'score' in entry ? Number(entry.score) : Number.NaN;
      const rationale = 'rationale' in entry && typeof entry.rationale === 'string' ? entry.rationale : '';
      const themesRaw =
        'themes' in entry && Array.isArray(entry.themes) ? (entry.themes as unknown[]) : [];
      const themes = themesRaw
        .filter((value): value is string => typeof value === 'string')
        .slice(0, 5);

      if (!threadId) {
        return null;
      }

      return {
        threadId,
        score: clampScore(score),
        rationale: rationale || 'No rationale provided',
        themes
      };
    })
    .filter((value): value is LlmCandidateScore => value !== null);
}

export async function scoreCandidateBatch(
  candidates: HeuristicCandidate[],
  options: ScoreBatchOptions
): Promise<LlmCandidateScore[]> {
  if (candidates.length === 0) {
    return [];
  }

  const { budget, fetchImpl = fetch, apiKey = OPENROUTER_API_KEY, model = DEFAULT_MODEL } = options;

  if (!apiKey) {
    throw new Error('openrouter_api_key_missing');
  }

  const promptPayload = candidates.map((candidate) => ({
    threadId: candidate.metadata.threadId,
    subject: candidate.metadata.subject,
    participants: candidate.metadata.participants.length,
    messageCount: candidate.metadata.messageCount,
    latestSnippet: candidate.metadata.latestSnippet,
    heuristic: candidate.signals.total
  }));

  const response = await budget.withConcurrencySlot('llm', async () => {
    return fetchImpl(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        provider: {
          allow_fallbacks: false,
          data_collection: 'deny',
          zdr: true
        },
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'You rank Gmail thread metadata for narrative potential. Reply only JSON with {"scores":[{"threadId":"...","score":0..1,"rationale":"...","themes":["..."]}]}. Preserve every threadId exactly once.'
          },
          {
            role: 'user',
            content: JSON.stringify({ candidates: promptPayload })
          }
        ]
      })
    });
  });

  if (!response.ok) {
    throw new Error(`openrouter_request_failed:${response.status}`);
  }

  const body = (await response.json()) as OpenRouterResponse;
  const content = body.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('openrouter_response_missing_content');
  }

  return parseBatchScores(content);
}
