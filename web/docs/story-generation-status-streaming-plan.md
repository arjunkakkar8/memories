# Story Generation Status Streaming Plan

This plan introduces transparent, incremental status updates during story generation so users can see what the agent is doing in real time (for example: retrieving emails, finding related emails, writing story) plus a compact metadata snippet that reflects progress context. It also introduces token-by-token streaming for the final narrative output.

## Goals (Locked)

- Users see a live status update each time the story agent starts a new meaningful step.
- Each status can include a small, non-sensitive metadata payload to indicate current setup/work. This should be friendly and readable, not technical.
- Users see the final story appear incrementally token-by-token while the writer phase is running.
- Existing `/api/story` JSON contract remains compatible for current clients/tests.
- Failure behavior remains stable (same error envelope semantics), with better progress transparency.
- Changes align with existing scan SSE architecture patterns where practical.

## Non-Goals (For This Milestone)

- Streaming research tool transcripts or raw prompt internals.
- Exposing raw prompts/tool arguments that may contain sensitive data.
- Persisting detailed per-step telemetry to a new analytics backend.

## Current Baseline

- `web/src/routes/story/+page.svelte` calls `/api/story` with one blocking `POST` and shows a single loader state.
- `web/src/routes/api/story/+server.ts` returns one JSON response after `runStoryPipeline` finishes (or fails).
- `web/src/lib/server/story/pipeline.ts` and `web/src/lib/server/story/tools.ts` already have strong internal logging but no user-facing incremental stream.
- Scan flow (`/api/scan`) already uses SSE and provides a proven event-streaming reference implementation.

---

## Phase 0 - Event Contract and Compatibility Strategy

### Files touched

- New: `web/src/routes/api/story/events.ts`
- New: `web/src/lib/story/types.ts` (optional shared client types)
- `web/src/routes/api/story/+server.ts`

### Checklist

- [ ] Define story SSE event union with explicit schema and naming:
  - [ ] `story.started`
  - [ ] `story.status`
  - [ ] `story.token`
  - [ ] `story.complete`
  - [ ] `story.error`
  - [ ] `story.keepalive` (optional but recommended)
- [ ] Define status payload shape with compact metadata:
  - [ ] `label: string` (human-friendly status text)
  - [ ] `stage: string` (machine-friendly stage key)
  - [ ] `metadata?: Record<string, unknown>` (small snippet)
  - [ ] `timestamp: string`
- [ ] Define transport strategy using content negotiation:
  - [ ] If `Accept` includes `text/event-stream`, return SSE.
  - [ ] Otherwise preserve existing JSON behavior.
- [ ] Reuse stable story error mapping and envelope semantics.
- [ ] Define token payload shape:
  - [ ] `token: string`
  - [ ] `index: number`
  - [ ] `isFinal?: boolean`
  - [ ] `timestamp: string`

### Important factors

- Keep event naming predictable and future-proof.
- Keep metadata intentionally sparse and non-sensitive.
- Avoid introducing breaking changes to existing `/api/story` callers.

---

## Phase 1 - Pipeline Progress Hooking

### Files touched

- `web/src/lib/server/story/types.ts`
- `web/src/lib/server/story/pipeline.ts`

### Checklist

- [ ] Extend pipeline options with optional progress emitter callback.
- [ ] Add typed progress payload for internal pipeline stages.
- [ ] Emit progress updates at key stage boundaries:
  - [ ] pipeline start
  - [ ] selected thread prefetch started/succeeded
  - [ ] research phase started/completed
  - [ ] writer phase started/completed
  - [ ] retry scheduled/attempt started (LLM retry visibility)
- [ ] Include compact metadata per update (example: model, retry attempt, research steps count).

### Important factors

- Emit only meaningful transitions (avoid noisy per-line updates).
- Keep callback optional to avoid overhead when not streaming.
- Preserve existing logging and error behavior.

---

## Phase 2 - Tool-Level Activity Visibility

### Files touched

- `web/src/lib/server/story/tools.ts`
- `web/src/lib/server/story/types.ts` (if shared tool-stage event typing is needed)

### Checklist

- [ ] Emit status when each tool starts and completes:
  - [ ] `getSelectedThread`
  - [ ] `searchRelatedThreads`
  - [ ] `getParticipantHistory`
- [ ] Map tool events to user-friendly labels:
  - [ ] "Retrieving selected email thread"
  - [ ] "Finding related emails"
  - [ ] "Looking up participant history"
- [ ] Add compact metadata snippets, for example:
  - [ ] `{ tool: "searchRelatedThreads", hasParticipant: true, maxResults: 4 }`
  - [ ] `{ participant: "alex@example.com" }` (if acceptable; otherwise masked form)
  - [ ] `{ threadCount: 3, durationMs: 420 }`

### Important factors

- Do not expose full message contents or sensitive participant details by default.
- Keep labels stable to simplify UI rendering and test assertions.
- Ensure tool failures still route through existing error mapping.

---

## Phase 3 - Story API SSE Response Path

### Files touched

- `web/src/routes/api/story/+server.ts`
- New: `web/src/routes/api/story/stream-state.ts` (optional helper like scan)
- New: `web/src/routes/api/story/events.ts`

### Checklist

- [ ] Add SSE response path in `POST` handler when requested by `Accept` header.
- [ ] Reuse existing auth/body validation and error mapping logic before stream starts where possible.
- [ ] Emit ordered lifecycle events:
  - [ ] `story.started` immediately after stream setup
  - [ ] `story.status` for progress transitions from pipeline/tool callbacks
  - [ ] `story.token` during writer generation
  - [ ] `story.complete` with `{ story, metadata }` on success
  - [ ] `story.error` with stable `{ code }` envelope on failure
  - [ ] `story.keepalive` at interval while running
- [ ] Close stream safely on completion/error/cancellation.
- [ ] Keep JSON mode logic intact and shared with SSE mode to avoid drift.

### Important factors

- Ensure event ordering is deterministic for client state updates.
- Minimize code duplication between JSON and SSE paths (shared execution helper).
- Keep `x-story-request-id` support consistent across modes.

---

## Phase 4 - Writer Token Streaming Integration

### Files touched

- `web/src/lib/server/story/pipeline.ts`
- `web/src/lib/server/story/types.ts`
- `web/src/routes/api/story/+server.ts`

### Checklist

- [ ] Replace non-streaming writer call (`generateText`) with a streaming-capable writer path when SSE mode is active (for example `streamText` or equivalent SDK primitive).
- [ ] Emit `story.token` events as writer tokens/chunks arrive.
- [ ] Assemble the canonical final story server-side from streamed chunks to preserve current completion semantics.
- [ ] Continue to support non-streaming writer execution in JSON mode for backward compatibility.
- [ ] Ensure retry strategy for writer phase remains bounded and compatible with token streaming behavior.

### Important factors

- Keep research phase tool execution deterministic and non-streamed; only stream final writer output.
- Avoid sending empty/noise chunks to client.
- Preserve final story normalization rules (trim, empty check, error mapping) before `story.complete`.

---

## Phase 5 - Story Client Stream Utility

### Files touched

- New: `web/src/lib/story/client-stream.ts`
- New: `web/src/lib/story/story-store.ts` (optional, if state extraction is preferred)

### Checklist

- [ ] Implement SSE parser/consumer utility for story events (patterned after scan stream client).
- [ ] Support cancellation/abort and surface client-side stream errors.
- [ ] Add typed callback interface for handling events in page state.
- [ ] Ensure event parsing is resilient to partial chunks and unknown events.

### Important factors

- Keep implementation lightweight and route-specific.
- Normalize network/parse failures into clear client error messages.
- Avoid introducing global state unless needed by future routes.

---

## Phase 6 - Story Page UX for Status + Metadata Snippets

### Files touched

- `web/src/routes/story/+page.svelte`

### Checklist

- [ ] Switch story request path from blocking JSON fetch to SSE stream client.
- [ ] Add UI state for:
  - [ ] current status label
  - [ ] status timeline/history (optional compact list)
  - [ ] current metadata snippet
  - [ ] streaming story buffer (incremental text)
  - [ ] final story and error states
- [ ] Render progress updates transparently during generation:
  - [ ] keep loader visible
  - [ ] update status text each time a new stage starts
  - [ ] display compact metadata snippet beside/below status
  - [ ] render story text progressively during `story.token` events
- [ ] Preserve existing retry UX and error messaging behavior.
- [ ] Ensure responsive behavior on mobile and desktop.

### Important factors

- Keep UI concise: status should inform without overwhelming.
- Debounce/dedupe repeated status updates to reduce flicker.
- Throttle token paint frequency if needed to avoid excessive re-render churn.
- Ensure accessibility (`role="status"`, `aria-live="polite"`) for status changes.

---

## Phase 7 - Testing and Contract Validation

### Files touched

- `web/src/routes/story/page.svelte.spec.ts`
- `web/tests/story/story-route.test.ts`
- `web/tests/story/pipeline.test.ts`
- New tests for story stream parser (if split into utility module)

### Checklist

- [ ] Route/API tests:
  - [ ] JSON mode remains backward compatible.
  - [ ] SSE mode emits expected event order for success and failure.
  - [ ] SSE mode emits `story.token` events during writer phase.
  - [ ] Stable error codes preserved in `story.error` events.
- [ ] Pipeline tests:
  - [ ] progress callback receives stage transitions.
  - [ ] retry events emitted when retries happen.
  - [ ] tool progress events included where expected.
  - [ ] writer streaming path emits ordered token chunks and reconstructs final story.
- [ ] UI tests:
  - [ ] loader + initial status shown.
  - [ ] status label updates across multiple events.
  - [ ] metadata snippet updates and remains compact.
  - [ ] story text appears incrementally from token events.
  - [ ] final story renders on `story.complete`.
  - [ ] retry path still works after `story.error`.

### Important factors

- Assert invariants and ordering rather than brittle timing.
- Keep test fixtures representative but minimal.
- Reuse scan SSE test patterns where possible.

---

## Phase 8 - Rollout, Observability, and Hardening

### Files touched

- `web/src/routes/api/story/+server.ts`
- `web/src/lib/server/story/logging.ts` (if additional event fields are useful)
- Optional docs/changelog updates

### Checklist

- [ ] Add lightweight metrics/log markers for stream lifecycle:
  - [ ] stream started/completed/errored counts
  - [ ] average status-event count per request
  - [ ] average token-event count per request
  - [ ] story completion latency in stream mode
- [ ] Validate infra behavior for SSE headers and buffering (`x-accel-buffering: no`).
- [ ] Confirm no sensitive metadata is leaked in status payloads.
- [ ] Add fallback behavior if SSE is not supported (route can remain JSON-compatible).

### Important factors

- Keep operational visibility sufficient for debugging stream failures.
- Ensure stream closure and heartbeat cleanup avoid resource leaks.
- Confirm parity between stream-mode and JSON-mode results.

---

## Suggested Delivery Sequence

1. Phase 0 (contract + compatibility)
2. Phase 1 + Phase 2 (progress sources in pipeline/tools)
3. Phase 3 (SSE server path)
4. Phase 4 (writer token streaming)
5. Phase 5 + Phase 6 (client consumption + UI)
6. Phase 7 (tests)
7. Phase 8 (rollout hardening)

## Risk Register and Mitigations

- **Risk:** SSE path diverges from JSON behavior.
  - **Mitigation:** shared execution helper and shared error mapping.
- **Risk:** too many status events cause UI noise.
  - **Mitigation:** emit only stage transitions and dedupe repeated labels.
- **Risk:** token-level events can increase render and network overhead.
  - **Mitigation:** batch or throttle tiny chunks client-side while preserving perceptible streaming.
- **Risk:** accidental sensitive data exposure in metadata snippets.
  - **Mitigation:** explicit allowlist/shape for metadata fields.
- **Risk:** stream interruptions produce unclear UX.
  - **Mitigation:** map stream failures to clear retryable UI error state.

## Definition of Done

- Story page shows transparent, incremental status updates during generation.
- Each major agent step includes a compact metadata snippet.
- Final narrative appears incrementally token-by-token in the story UI.
- `/api/story` supports SSE progress while preserving JSON compatibility.
- Existing stable error semantics remain intact.
- Automated tests cover success, failure, retry, event ordering, and token streaming.
- UX remains responsive and accessible on desktop and mobile.
