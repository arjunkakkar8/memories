# Story Exploration Broadening: Phased Implementation Plan

This plan expands story research from narrow thread-local lookup to broad, context-aware exploration across related concepts, people, and adjacent threads. It also adds Markdown-first story output and user-personalized narration.

## Goals (Locked)

- Default story research runs in **deep** mode with broader Gmail exploration coverage.
- Research explicitly covers:
  - selected thread details,
  - related threads,
  - participant-network context,
  - concept/keyword neighborhoods,
  - timeline-adjacent threads.
- Final story output is generated as **Markdown**.
- Story voice is **personalized to the signed-in user** (default: second-person) while remaining evidence-grounded.
- Existing `/api/story` JSON and SSE contracts remain backward compatible.
- Architecture leaves room to switch between `fast` / `balanced` / `deep` exploration profiles in the future.

## Non-Goals (For This Milestone)

- Persisting new long-term memory graphs outside current request scope.
- Expanding OAuth permissions beyond current Gmail readonly access.
- Replacing existing scan candidate ranking pipeline.

---

## Phase 0 - Foundations and Contract Shapes

### Files touched

- `web/src/lib/server/story/types.ts`
- `web/src/lib/story/types.ts`
- `web/src/routes/api/story/+server.ts`
- Optional docs updates under `web/docs/`

### Checklist

- [ ] Add optional `exploration` request options to story pipeline/request types:
  - [ ] `profile: 'fast' | 'balanced' | 'deep'`
  - [ ] optional overrides (bounded): `maxResearchSteps`, `minRelatedThreads`, `minParticipantHistories`, `minConceptThreads`
- [ ] Keep `threadId` required and all new fields optional for compatibility.
- [ ] Extend story metadata shape with additive fields:
  - [ ] `format: 'markdown'`
  - [ ] exploration summary counts (for diagnostics only)
- [ ] Add `viewerContext` shape (derived from authenticated session user) for personalized writing.

### Important factors

- Preserve old callers that send only `{ threadId }`.
- Keep SSE event names unchanged; only extend payload metadata additively.

---

## Phase 1 - Exploration Profiles and Quota Budget Upgrade

### Files touched

- `web/src/lib/server/story/gmail-research.ts`
- `web/src/lib/server/story/pipeline.ts`
- Optional new config file: `web/src/lib/server/story/config.ts`

### Checklist

- [ ] Introduce exploration profile defaults:
  - [ ] `deep` (default for now)
  - [ ] `balanced`
  - [ ] `fast`
- [ ] Raise story Gmail budget for deep profile (for example 220 -> 1200 units).
- [ ] Tune Gmail concurrency for deeper traversal (for example 3 -> 5) while keeping bounded guardrails.
- [ ] Make `MAX_RESEARCH_STEPS` profile-driven and request-overridable under hard server caps.
- [ ] Ensure budget snapshots/logging include chosen profile and effective limits.

### Important factors

- Internal budget increases do not automatically increase Google Cloud project quotas; monitor provider-side limits separately.
- All overrides must be clamped to safe maximums server-side.

---

## Phase 2 - Gmail Research Expansion Primitives

### Files touched

- `web/src/lib/server/story/gmail-research.ts`
- `web/src/lib/server/story/types.ts`
- New tests: `web/tests/story/gmail-research.test.ts`

### Checklist

- [ ] Add broader search primitives beyond current participant/subject-only lookup:
  - [ ] concept/keyword-driven thread search
  - [ ] timeline window search (`after:` / `before:` around key moments)
  - [ ] participant-neighborhood expansion
- [ ] Add paginated `threads.list` support for story exploration searches.
- [ ] Deduplicate thread IDs across pages/queries before details fetch.
- [ ] Fetch thread details in bounded parallel batches under quota budget slots.
- [ ] Tag discovered threads with provenance source metadata (query/tool origin) for downstream writer grounding.

### Important factors

- Keep Gmail query construction explicit and auditable.
- Maintain robust retry/fail-fast behavior for non-retryable Gmail errors.

---

## Phase 3 - Tool Runtime Broadening and State Model Upgrades

### Files touched

- `web/src/lib/server/story/tools.ts`
- `web/src/lib/server/story/types.ts`
- New/updated tests around tool runtime behavior

### Checklist

- [ ] Add tools for broad exploration (examples):
  - [ ] `searchThreadsByConcept`
  - [ ] `searchThreadsByTimeWindow`
  - [ ] `expandParticipantNetwork`
- [ ] Keep existing tools (`getSelectedThread`, `searchRelatedThreads`, `getParticipantHistory`) intact.
- [ ] Merge participant history across repeated tool calls (do not overwrite prior state).
- [ ] Store and expose provenance/source labels in context assembly.
- [ ] Emit user-facing progress for new tools with compact metadata snippets.

### Important factors

- Tool labels should stay stable and non-sensitive.
- Preserve deterministic context build and dedupe behavior.

---

## Phase 4 - Coverage-Driven Research Orchestration

### Files touched

- `web/src/lib/server/story/pipeline.ts`
- `web/src/lib/server/story/prompt.ts`
- `web/src/lib/server/story/types.ts`
- `web/tests/story/pipeline.test.ts`

### Checklist

- [ ] Update research prompt to require explicit breadth coverage before completion.
- [ ] Add coverage guards after agentic research:
  - [ ] minimum related-thread count
  - [ ] minimum participant-history breadth
  - [ ] minimum concept-branch exploration
- [ ] If coverage is insufficient, run deterministic fallback expansion (non-LLM) before writing.
- [ ] Keep selected-thread prefetch as fail-fast safety step.
- [ ] Include exploration summary in metadata for observability.

### Important factors

- Keep bounded total cost and runtime through profile-aware limits.
- Avoid relying solely on model behavior for breadth guarantees.

---

## Phase 5 - Personalized Markdown Story Prompting

### Files touched

- `web/src/lib/server/story/prompt.ts`
- `web/src/lib/server/story/pipeline.ts`
- `web/src/lib/server/story/types.ts`
- `web/tests/story/pipeline.test.ts`

### Checklist

- [ ] Change writer system and prompt requirements to produce Markdown output.
- [ ] Define lightweight Markdown structure requirements (for example title + sectioned narrative).
- [ ] Inject `viewerContext` into writer prompt.
- [ ] Switch default narration policy from detached third-person to personalized second-person voice.
- [ ] Keep evidence-grounding constraints: no invented facts, no leakage outside research context.

### Important factors

- Keep tone human and narrative, not report-like bullet dumps.
- Markdown structure should enhance readability without forcing rigid templates.

---

## Phase 6 - API/UI Wiring for Seeds and Rendering

### Files touched

- `web/src/routes/+page.svelte`
- `web/src/lib/ui/candidate-browser/story-handoff.ts`
- `web/src/routes/story/+page.server.ts`
- `web/src/lib/story/client-stream.ts`
- `web/src/routes/api/story/+server.ts`
- `web/src/routes/story/+page.svelte`

### Checklist

- [ ] Pass handoff seeds (subject/participants) from candidate click to story route and API request.
- [ ] Parse optional seed params in story page load and forward them as optional exploration hints.
- [ ] Extend `/api/story` request schema to accept optional exploration hints and profile.
- [ ] Preserve JSON and SSE transport behavior.
- [ ] Render story Markdown safely in the story page.
- [ ] Keep existing retry and error UX semantics unchanged.

### Important factors

- Sanitize Markdown rendering path to avoid unsafe HTML injection.
- Keep UI responsive while story tokens stream.

---

## Phase 7 - Test Coverage and Backward-Compatibility Validation

### Files touched

- `web/tests/story/pipeline.test.ts`
- `web/tests/story/gmail-research.test.ts`
- `web/tests/story/story-route.test.ts`
- `web/src/routes/story/page.svelte.spec.ts`
- `web/src/routes/page.svelte.spec.ts`

### Checklist

- [ ] Pipeline tests validate deep-default exploration and breadth fallback behavior.
- [ ] Pipeline tests validate personalized + Markdown prompt construction.
- [ ] Gmail research tests validate pagination, dedupe, and concept/time-window query behavior.
- [ ] API route tests validate:
  - [ ] legacy `{ threadId }` requests still succeed,
  - [ ] optional exploration payload path,
  - [ ] stable error envelopes and SSE events.
- [ ] Story page tests validate Markdown rendering and streaming compatibility.
- [ ] Landing page navigation tests updated for enriched story handoff query params.

### Important factors

- Prefer invariant assertions over brittle exact-string snapshots for generated prompts.
- Ensure no tests depend on random exploration order without deterministic fixtures/mocks.

---

## Phase 8 - Rollout and Operational Guardrails

### Files touched

- `web/src/lib/server/story/logging.ts`
- `web/src/routes/api/story/+server.ts`
- Optional runbook/docs updates

### Checklist

- [ ] Add metrics/log counters for exploration breadth outcomes:
  - [ ] related threads discovered,
  - [ ] participant histories loaded,
  - [ ] concept threads found,
  - [ ] total Gmail units consumed.
- [ ] Track deep-profile latency and error-rate changes.
- [ ] Add guardrail alerts for quota-exceeded and Gmail throttling patterns.
- [ ] Validate no sensitive fields are emitted in progress metadata.

### Important factors

- Deep mode should remain observable and tunable without code rewrites.
- Keep space to switch default profile from `deep` to `balanced` if production metrics require it.

---

## Suggested Delivery Sequence

1. Phase 0 + Phase 1 (contracts + deep profile + budget uplift)
2. Phase 2 + Phase 3 (research primitives + tools/state)
3. Phase 4 (coverage orchestration)
4. Phase 5 (personalized Markdown writer behavior)
5. Phase 6 (UI/API handoff + rendering)
6. Phase 7 (tests)
7. Phase 8 (rollout hardening)

## Definition of Done

- Story research consistently explores broader contextual neighborhoods around the selected thread.
- Deep profile is default, with additive support for future configurable profiles.
- Final story is returned as Markdown and rendered safely in UI.
- Narrative is personalized to the signed-in user, not detached third-person by default.
- Existing route contracts remain backward compatible.
- Tests cover breadth logic, personalization, Markdown output, and API/UI compatibility.
