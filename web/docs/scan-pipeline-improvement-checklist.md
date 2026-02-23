# Scan Pipeline Improvement Checklist

This checklist converts the agreed plan into implementation phases for improving candidate generation during email scan.

## Goals (Locked)

- Retrieval uses fully random historical intervals per run (no stable seed).
- Heuristic scoring removes recency as a positive signal.
- The pipeline always returns at least 5 candidates, even when scores are weak.
- Design remains Gmail API grounded (`q`, `labelIds`, `threads.list`/`threads.get`) and quota aware.

## Current Baseline

- `src/lib/server/scan/pipeline.ts` runs one metadata fetch pass and ranks by heuristic + optional LLM fallback.
- `src/lib/server/scan/heuristics.ts` uses depth/diversity/recency/continuity.
- `src/lib/server/scan/gmail-source.ts` fetches thread list/details with budget/concurrency.
- LLM scoring loop is currently commented out in `pipeline.ts`.

---

## Phase 0 - Foundations and Config

### Files touched

- `src/lib/server/scan/types.ts`
- `src/lib/server/scan/pipeline.ts`
- `src/routes/api/scan/+server.ts` (if request payload options are expanded)
- New: `src/lib/server/scan/config.ts` (optional)

### Checklist

- [ ] Add central scan constants/config for:
  - [ ] `MIN_RETURNED_CANDIDATES = 5`
  - [ ] default query-pack budgets
  - [ ] random interval count/duration options
  - [ ] heuristic weights and thresholds (without recency)
- [ ] Extend server-side option types so pipeline can accept future query-pack overrides safely.
- [ ] Add/expand types for retrieval provenance metadata (pack IDs, sampled windows, hit counts).

### Important factors

- Keep defaults conservative so API route behavior remains stable without payload changes.
- Ensure backward compatibility with current SSE events unless explicitly changing contract.

---

## Phase 1 - Query Packs and Random Time Window Sampling

### Files touched

- New: `src/lib/server/scan/query-packs.ts`
- New: `src/lib/server/scan/window-sampler.ts`
- `src/lib/server/scan/pipeline.ts`
- `src/lib/server/scan/gmail-source.ts`
- `src/lib/server/scan/types.ts`

### Checklist

- [ ] Define query packs grounded in Gmail `q` syntax and optional `labelIds`.
- [ ] Implement fully random interval sampling per run:
  - [ ] random start time
  - [ ] random duration from allowed set (for example 7d/30d/90d/180d)
  - [ ] optional overlap cap within same run
- [ ] Build query materialization that appends `after:`/`before:` epoch seconds.
- [ ] Update metadata fetch entry points to support per-pack queries and labels.
- [ ] Orchestrate `(pack x random window)` retrieval jobs in pipeline under quota constraints.
- [ ] Dedupe thread IDs globally while preserving provenance contributions from all hits.
- [ ] Emit progress updates that identify active pack/window retrieval stages.

### Important factors

- Gmail API date handling: use epoch seconds to avoid PST-midnight skew.
- Gmail API does not support UI alias expansion; if alias support is needed later, implement explicit account alias expansion in query building.
- Keep job fan-out bounded by budget and Gmail concurrency limits.

---

## Phase 2 - Metadata Enrichment for Better Heuristics

### Files touched

- `src/lib/server/scan/gmail-source.ts`
- `src/lib/server/scan/types.ts`

### Checklist

- [ ] Extend fetched thread metadata with fields needed for scoring quality:
  - [ ] normalized participant addresses (where possible)
  - [ ] label IDs or derived importance markers
  - [ ] lexical-analysis-ready subject/snippet text surfaces
- [ ] Preserve low-cost API usage (metadata format, limited headers, no full body fetch by default).
- [ ] Ensure parsers are robust to missing headers and malformed values.

### Important factors

- Avoid heavy payload growth that materially increases latency.
- Do not introduce brittle parsing assumptions for participant names or comma-splitting edge cases.

---

## Phase 3 - Heuristics v2 (No Recency)

### Files touched

- `src/lib/server/scan/heuristics.ts`
- `src/lib/server/scan/types.ts`
- `src/lib/server/scan/pipeline.ts`

### Checklist

- [ ] Remove recency from signal model and scoring output.
- [ ] Introduce new positive signals:
  - [ ] `provenanceStrength`
  - [ ] `actionabilityLexical`
  - [ ] `resurfacing`
  - [ ] `historicalPersistence`
  - [ ] existing `continuity`
  - [ ] existing `messageDepth`
  - [ ] existing `participantDiversity`
  - [ ] `novelty` (when persistence memory is available)
  - [ ] `importanceMarkers`
- [ ] Introduce penalties:
  - [ ] `bulkNoisePenalty`
  - [ ] `receiptAutoMailPenalty`
  - [ ] `redundancyPenalty`
  - [ ] `singleShotPenalty`
- [ ] Implement score clamping and deterministic tie-break strategy.
- [ ] Keep configurable thresholds and fallback-safe defaults.

### Important factors

- Ensure score components are explainable for debugging and future tuning.
- Keep lexical heuristics compact and auditable (avoid opaque mega-regexes).

---

## Phase 4 - Ranking, Diversity, and Minimum-5 Guarantee

### Files touched

- `src/lib/server/scan/pipeline.ts`
- `src/lib/server/scan/heuristics.ts`
- `src/lib/server/scan/types.ts`

### Checklist

- [ ] Add diversity pass after scoring:
  - [ ] sender/domain cap
  - [ ] normalized subject-root cap
  - [ ] optional age-bucket balancing (recent/mid/old)
- [ ] Implement hard guarantee that final result returns at least 5 candidates:
  - [ ] fill from below-threshold scored pool first
  - [ ] then fill from dropped pool by strongest non-noise signals
  - [ ] continue until 5 candidates or input exhausted
- [ ] Add explicit progress message when fallback fill is used.
- [ ] Preserve deterministic ranking after fallback insertion.

### Important factors

- Do not allow fallback to flood results with obvious low-value bulk mail unless absolutely no alternatives exist.
- Ensure no duplicate `threadId` in final ranked list.

---

## Phase 5 - Optional LLM Reranking Reintegration

### Files touched

- `src/lib/server/scan/pipeline.ts`
- `src/lib/server/scan/llm-score.ts`
- `src/lib/server/scan/types.ts`

### Checklist

- [ ] Re-enable batch LLM scoring behind a feature flag or config gate.
- [ ] Restrict LLM scoring to top-K heuristic candidates to control cost.
- [ ] Keep robust fallback to heuristic-only rank if API key/model unavailable or request fails.
- [ ] Ensure SSE `scan.candidates` batches remain valid as intermediate updates.

### Important factors

- LLM should rerank, not replace, deterministic heuristic quality controls.
- Preserve privacy posture already configured in OpenRouter request settings.

---

## Phase 6 - Persistence for Novelty and Repeat Avoidance

### Files touched

- New (likely): `src/lib/server/scan/scan-memory-store.ts`
- `src/lib/server/scan/pipeline.ts`
- `src/lib/server/scan/types.ts`

### Checklist

- [ ] Persist per-user recent surfaced `threadId`s and sampled window ranges.
- [ ] Add novelty boost for unsurfaced threads and dampening for recent repeats.
- [ ] Use memory store to reduce immediate re-sampling of near-identical windows.
- [ ] Add retention policy (for example last N runs or last X days).

### Important factors

- Keep storage bounded and resilient to missing/evicted state.
- Memory store should improve freshness, not hard-block genuinely important recurring candidates.

---

## Phase 7 - Testing, Telemetry, and Guardrails

### Files touched

- `src/routes/page.svelte.spec.ts` (candidate shape updates)
- New/updated tests under `tests/` and/or `src/lib/server/scan/*.spec.ts`
- Optional logs/metrics integration points in `pipeline.ts`

### Checklist

- [ ] Unit tests:
  - [ ] random window generator bounds/behavior
  - [ ] query-pack materialization correctness (`after:`/`before:` epoch)
  - [ ] heuristic signal and penalty calculations
  - [ ] minimum-5 fallback behavior
  - [ ] dedupe and diversity constraints
- [ ] Integration tests:
  - [ ] pipeline returns candidates across multiple random windows
  - [ ] no empty list when retrieval yields weak scores but enough raw metadata
  - [ ] SSE event stream remains compatible
- [ ] Add basic metrics counters:
  - [ ] candidates fetched/kept/dropped/fallback-added
  - [ ] pack hit distribution
  - [ ] quota units consumed per stage

### Important factors

- Because retrieval is fully random per run, tests should validate invariants and bounds, not exact candidate IDs.
- Add deterministic test mode only in tests if needed (mocked RNG), while production remains fully random.

---

## Suggested Delivery Order

1. Phase 0 + Phase 1 (retrieval architecture)
2. Phase 2 + Phase 3 (signal quality)
3. Phase 4 (diversity and minimum-5 guarantee)
4. Phase 7 baseline tests before optional LLM changes
5. Phase 5 and Phase 6 after heuristic baseline stabilizes

## Definition of Done (Initial Milestone)

- Pipeline samples random historical intervals every run.
- Recency is absent from heuristic score computation.
- Final output always returns at least 5 deduped candidates when at least 5 threads were retrieved.
- Progress events and client rendering continue to function.
- Tests cover scoring invariants and fallback guarantees.
