import { createQuotaBudget, type QuotaBudget } from './quota-budget';
import { fetchGmailThreadMetadata } from './gmail-source';
import { filterCandidates } from './heuristics';
import { scoreCandidateBatch } from './llm-score';
import type {
  HeuristicCandidate,
  LlmCandidateScore,
  RankedScanCandidate,
  ScanPipelineProgress,
  ScanPipelineResult
} from './types';

type RunScanPipelineOptions = {
  accessToken: string;
  budget?: QuotaBudget;
  fetchImpl?: typeof fetch;
  openRouterFetchImpl?: typeof fetch;
  openRouterApiKey?: string;
  openRouterModel?: string;
  query?: string;
  pageSize?: number;
  maxPages?: number;
  maxThreads?: number;
  llmBatchSize?: number;
  onProgress?: (entry: ScanPipelineProgress) => void;
  onCandidateBatch?: (entry: { batchIndex: number; candidates: RankedScanCandidate[] }) => void;
};

function toRankedCandidates(
  candidates: HeuristicCandidate[],
  llmScores: LlmCandidateScore[]
): RankedScanCandidate[] {
  const scoreByThreadId = new Map(llmScores.map((entry) => [entry.threadId, entry]));

  const merged = candidates.map((candidate) => {
    const llmScore = scoreByThreadId.get(candidate.metadata.threadId) ?? {
      threadId: candidate.metadata.threadId,
      score: candidate.signals.total,
      rationale: 'Fallback to heuristic-only score due to missing LLM score',
      themes: []
    };

    return {
      threadId: candidate.metadata.threadId,
      metadata: candidate.metadata,
      signals: candidate.signals,
      llm: llmScore,
      combinedScore: candidate.signals.total * 0.4 + llmScore.score * 0.6,
      rank: 0
    } satisfies RankedScanCandidate;
  });

  merged.sort((left, right) => right.combinedScore - left.combinedScore);

  for (let index = 0; index < merged.length; index += 1) {
    merged[index].rank = index + 1;
  }

  return merged;
}

export async function runScanPipeline(options: RunScanPipelineOptions): Promise<ScanPipelineResult> {
  const {
    accessToken,
    query,
    pageSize,
    maxPages,
    maxThreads,
    llmBatchSize = 10,
    fetchImpl = fetch,
    openRouterFetchImpl = fetch,
    openRouterApiKey,
    openRouterModel,
    onProgress,
    onCandidateBatch
  } = options;

  const budget = options.budget ?? createQuotaBudget();
  const progress: ScanPipelineProgress[] = [];

  const emit = (entry: ScanPipelineProgress): void => {
    progress.push(entry);
    onProgress?.(entry);
  };

  const metadata = await fetchGmailThreadMetadata({
    accessToken,
    budget,
    fetchImpl,
    query,
    pageSize,
    maxPages,
    maxThreads
  });

  emit({
    stage: 'fetch',
    processed: metadata.length,
    total: metadata.length,
    message: `Fetched metadata for ${metadata.length} thread(s)`
  });

  const filtered = filterCandidates(metadata);
  emit({
    stage: 'heuristics',
    processed: filtered.kept.length,
    total: metadata.length,
    message: `Heuristic filter kept ${filtered.kept.length} of ${metadata.length} thread(s)`
  });

  if (filtered.kept.length === 0) {
    emit({
      stage: 'complete',
      processed: 0,
      total: 0,
      message: 'Scan complete with no strong candidates'
    });

    return {
      rankedCandidates: [],
      progress
    };
  }

  const llmScores: LlmCandidateScore[] = [];

  //// Turing this off for testing to conserve compute
  // for (let start = 0; start < filtered.kept.length; start += llmBatchSize) {
  //   const batch = filtered.kept.slice(start, start + llmBatchSize);
  //   const batchScores = await scoreCandidateBatch(batch, {
  //     budget,
  //     fetchImpl: openRouterFetchImpl,
  //     apiKey: openRouterApiKey,
  //     model: openRouterModel
  //   });
  //
  //   llmScores.push(...batchScores);
  //   onCandidateBatch?.({
  //     batchIndex: Math.floor(start / llmBatchSize),
  //     candidates: toRankedCandidates(batch, batchScores)
  //   });
  //
  //   emit({
  //     stage: 'llm',
  //     processed: Math.min(start + batch.length, filtered.kept.length),
  //     total: filtered.kept.length,
  //     message: `Scored ${Math.min(start + batch.length, filtered.kept.length)} of ${filtered.kept.length} candidate(s)`
  //   });
  // }

  const rankedCandidates = toRankedCandidates(filtered.kept, llmScores);
  emit({
    stage: 'complete',
    processed: rankedCandidates.length,
    total: rankedCandidates.length,
    message: `Scan complete with ${rankedCandidates.length} ranked candidate(s)`
  });

  return {
    rankedCandidates,
    progress
  };
}
