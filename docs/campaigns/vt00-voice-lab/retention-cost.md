# VT00 retention and cost policy

Status: `DRAFT — DASHBOARD QUOTE, ENFORCEMENT, AND APPROVAL PENDING`

## Default data policy

| Data class | Default | Proposed maximum | Required disposition |
|---|---|---:|---|
| Raw input/output audio or video | Disabled | Scenario-specific, operator-approved | Governed artifact only; never embedded in MCP text |
| Event ledger and utterance hashes | Enabled | Signed per-run bound, 1–168 hours after canonical finalization | Hard-delete at the local deadline even if product cleanup is temporarily unavailable |
| Screenshot | Optional | Same signed per-run bound | Redact/crop before any separately approved longer preservation |
| Evidence manifest and derived metrics | Enabled | Same signed per-run bound | Export externally only as an explicitly approved redacted campaign archive; the live lab does not silently extend retention |
| Failed-run diagnostic evidence | Enabled when safe | Same signed per-run bound | Preserve enough for classification during the bound; no indefinite failure exception |
| Authentication/admission audit metadata | Enabled, content-free and pseudonymous | Explicit bounded control-log window | Keyed caller identifiers and hashes only; no bearer values, raw principal, transcript, or test-run identity |
| LangSmith supplemental trace | Disabled for synthetic certification | Not applicable | Report `trace_unavailable: synthetic_isolation_policy`; canonical product evidence remains authoritative |

The runtime accepts a per-run retention bound of 1–168 hours. Certification should request 24 hours unless an approved scenario specifies less. The authenticated claim carries `retention_hours`; the provisional product expiry is anchored to session creation as a hard safety ceiling. A canonical finalization committed before that deadline atomically resets the authoritative deadline to `finalized_at + retention_hours`, and the transcript, session, finalization receipt, and lab ledger must agree exactly. Once the provisional deadline is reached, the same database cleanup barrier rejects provisional-to-final retention promotion and cleanup wins; an overdue request cannot extend raw-session retention by finalizing late. A configured TTL is not proof of deletion: the local hard-deadline purge, product-owned expiry reaper, artifact deletion, and read-after-delete audit must be demonstrated before the retention control is marked passing.

Local evidence deletion does not wait indefinitely for a remote product service. If remote cleanup is unavailable at the signed deadline, the lab deletes its raw run identity and evidence, retains only the approved keyed content-free tombstone for its bounded control window, and truthfully records remote purge as unconfirmed. The product plane independently owns a cancellation-safe, progress-guaranteed, lease-fenced expiry reaper so session, provider, Builder, authentication, finalization, and artifact cleanup remains possible after browser, worker, Voice, or deployment replacement. A timeout may not abandon a background lease acquisition, and malformed early rows may not starve later valid obligations.

Each admitted run carries a random opaque `cleanup_obligation_id`, signed into the capability and copied unchanged into every synthetic session, message, finalization, provider session, Builder thread/task/artifact, and authentication record. It is the only cross-store cleanup index that may remain in a `prepared` handle after the raw principal and run identity are erased. A prepared handle is never purge proof and cannot be reported as `complete`; it contains no principal, test-run, transcript, deployment, or content metadata. Its `control_expires_at` is an operational SLO: crossing it must degrade readiness, raise an overdue incident, and continue retrying, but must not destroy the last actionable cleanup authority. Under the shared cleanup barrier, the reaper must delete and read-verify every indexed source, write the identity-free completed tombstone, then delete and read-verify the prepared handle. Writes and identity/deadline rebinds are rejected once the obligation is expired or prepared. A crash, rolling deployment, truncated discovery, or unavailable store must remain replayable or surface a fail-closed incident, never silently extend raw evidence retention or mint a false completed tombstone.

Synthetic LangSmith export is disabled before client or trace allocation. LangSmith Cloud's shortest documented base trace retention is 14 days, while trace-deletion requests are asynchronous and provide no immediate deletion confirmation; neither meets this campaign's 24-hour default or seven-day maximum. An isolated trace project therefore remains an unapproved future exception, not a promotion dependency. V-L01 exercises the governed unavailable/fault boundary and proves that canonical local evidence and Sophia behavior remain independent of tracing.

## Raw-audio exception

Raw audio remains off in the Blueprint. An exception requires all of:

- the isolated synthetic principal;
- a named scenario and written privacy approval;
- explicit input/output scope and byte ceiling;
- a retention time shorter than or equal to the event ledger;
- encrypted governed storage and caller-scoped retrieval;
- deletion verification after analysis.

If the implementation cannot store, retrieve, and delete the governed artifact truthfully, reject the raw-audio request rather than claiming capture.

## Minimum isolated production footprint

The Blueprint requests:

- one Render `starter` public web instance;
- one Render `starter` background worker;
- one Render Postgres `basic-256mb` instance with 15 GB storage and no public IP allowlist;
- exactly one instance of each service, a one-run global ceiling, and a one-run per-caller ceiling. Suite children run sequentially because the current Gateway active-session map is keyed by the one dedicated principal.

These are minimal paid production instance types, not a performance certification. Browser memory, provider concurrency, and evidence volume must be measured before increasing capacity.

The non-binding planning estimate is two `starter` service-months plus one `basic-256mb` database-month, storage, and metered provider usage. It is a capacity formula, not a monetary quote or budget authorization.

### Official-price planning snapshot

Checked 2026-08-23:

- Render lists a continuously running `starter` service at **USD 7/month**, prorated by the second. Two always-on Voice Lab services therefore plan at **USD 14/month** before bandwidth and build-minute overages.
- Render's July 2026 small-production snapshot prices one `starter` service plus `basic-256mb` Postgres at about **USD 13/month** before storage growth. Subtracting the published USD 7 service rate implies approximately **USD 6/month** for the database compute; this value is an inference and must be replaced by the dashboard quote at provisioning.
- Flexible Postgres storage is **USD 0.30/GB-month**. The 15 GB Blueprint request plans at **USD 4.50/month**.
- The resulting always-on infrastructure estimate is therefore approximately **USD 24.50/month** (`14 + 6 + 4.50`), excluding any workspace-plan increment, egress, build minutes, Gemini, and retained-evidence growth. Suspending the isolated services after the campaign reduces prorated compute but is not yet counted as savings.
- The repository's current `gemini-3.1-flash-live-preview` price is **USD 0.005/minute of audio input** and **USD 0.018/minute of audio output** (equivalently USD 3 and USD 12 per million audio tokens). Text output, thinking, and enabled input/output transcription are additionally metered at the published text rates; the campaign must reconcile provider billing rather than estimating only wall-clock audio.
- Runtime generated test speech uses the image's local governed `espeak-ng` binary, so there is no separate TTS API line item; its compute is included in the worker instance. A future remote TTS provider requires a new quoted budget and allowlist.

Sources: [Render compute/pricing overview](https://render.com/articles/how-much-does-cloud-application-hosting-cost-for-small-businesses), [Render flexible Postgres](https://render.com/docs/postgresql-refresh), [Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing), and [LangSmith data purging and retention](https://docs.langchain.com/langsmith/data-purging-compliance). Prices remain non-binding until the actual dashboards and invoices are captured.

## Campaign cost worksheet

Current provider and Render prices must be entered from the operator's billing consoles at campaign time.

| Cost component | Unit price | Planned units | Maximum authorized | Actual | Evidence |
|---|---:|---:|---:|---:|---|
| MCP starter instance | USD 7/service-month | 1 prorated instance | `PENDING` | `PENDING` | Render dashboard/invoice `PENDING` |
| Worker starter instance | USD 7/service-month | 1 prorated instance | `PENDING` | `PENDING` | Render dashboard/invoice `PENDING` |
| Postgres basic-256mb + disk | about USD 6 compute + USD 0.30/GB-month; dashboard quote authoritative | 1 instance + 15 GB | `PENDING` | `PENDING` | Render dashboard/invoice `PENDING` |
| Gemini input/output audio | USD 0.005 input minute / USD 0.018 output minute, plus text/transcription/context charges | metered campaign usage | `PENDING` | `PENDING` | Google billing export `PENDING` |
| TTS generation | local `espeak-ng`; no separate API charge | bounded generated utterances | included in worker | `PENDING` | worker runtime reconciliation `PENDING` |
| LangSmith supplemental traces | synthetic export disabled by isolation policy | 0 synthetic traces | 0 | `PENDING` | typed-unavailable receipt and zero-allocation audit `PENDING` |
| Artifact/database storage | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` |

## Spend controls

- Keep auto-deploy disabled and the kill switch engaged outside a recorded campaign window.
- Bound text, audio bytes, run duration, operation duration, concurrent runs, and suite size.
- Enforce durable rolling ceilings for run starts, provider-seconds reservations, suite children, injected duration, and injected bytes before any browser, provider, or TTS allocation. Replays consume the original reservation and a retention-purged idempotency key cannot allocate again.
- Rate-limit public OAuth endpoints durably and purge expired authorization, code, access, refresh, assertion, and admission rows on a periodic maintenance loop even when no new request arrives.
- Reject malformed/unauthorized work before browser or provider resource creation.
- Use deterministic fixtures where possible. Generated TTS is ephemeral and must not be persisted or cached unless a separately approved governed-artifact policy is added.
- Stop on budget exhaustion; do not broaden limits automatically.
- Reconcile provider usage, Render runtime hours, retained bytes, and terminal cleanup in the campaign report.

## Closeout

Record the final terminal time, purge deadline, purge execution time, rows/artifacts deleted, approved archives retained, and operator identity. Cost and retention gates remain `PENDING` until both billing reconciliation and deletion evidence are attached.
