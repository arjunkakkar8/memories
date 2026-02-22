# Story Generation: Investigation Plan and Proposed Fix

## Investigated failure vectors
- **Rate limits / provider instability:** Gmail (`429/403/5xx`) and model provider (`429/5xx`) can fail under load.
- **Agent flow issues:** research tool flow can fail to gather required context in time, or fail to fetch the selected thread.
- **Access issues:** expired Gmail access token, missing refresh token, or lost in-memory token/session state.
- **Output issues:** model can return empty/invalid narrative output.

## Latest production-log finding
- Current failures are dominated by repeated Gmail `403` responses on `threads.get` / `threads.list`, which strongly indicates permission/scope/access configuration issues rather than model instability.
- Provider message confirms scope mismatch: `"Metadata scope doesn't allow format FULL"`.

## What was implemented
- Added structured, correlated logging for the full story pipeline:
  - request lifecycle + token refresh path (`/api/story`)
  - research/writer stage attempts + retry timing (`story/pipeline.ts`)
  - tool-level execution traces (`story/tools.ts`)
  - Gmail request retry diagnostics with operation labels + `Retry-After` support (`story/gmail-research.ts`)
- Added retries with exponential backoff for retryable LLM failures.
- Added `x-story-request-id` response header to correlate frontend failures with backend logs.
- Added Gmail error-reason extraction and reason-aware retry behavior so non-retryable `403` classes fail fast.
- Added a fail-fast selected-thread prefetch before LLM research to avoid long model/tool loops when Gmail access is already blocked.
- Added mapping of Gmail `insufficientPermissions`/auth-style `403` errors to `gmail_reauth_required`.
- Added explicit scope validation on OAuth callback to reject sign-in sessions that do not include `gmail.readonly`.
- Added explicit metadata-scope error classification (`metadataScopeFullFormatForbidden`) to make root cause actionable.

## Proposed solution path
1. **Observe and classify** (immediate): monitor log buckets by error family (`gmail_request_failed:*`, `openrouter_request_failed:*`, `story_generation_empty`).
2. **Stabilize auth persistence** (short term): replace in-memory session/token stores with durable storage to prevent restart/instance loss.
3. **Tighten resilience** (short-medium term): add bounded retries/jitter around known transient provider classes and alert on elevated 429/5xx rates.
4. **Operationalize quality** (medium term): track story success rate, refresh recovery rate, and provider-throttle incidence as explicit metrics.

## Success criteria
- Failures are diagnosable via request ID and structured logs.
- Expired-token cases recover automatically when refresh token exists.
- Provider throttling is measurable and does not appear as opaque generic failures.
- Story generation success rate remains stable under expected traffic.
