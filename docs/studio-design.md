# OMP Studio Design

## Status

This document defines the local single-user OMP Studio MVP. Studio is a web
control plane for OMP; it is not a fork of the OMP runtime and does not replace
OMP's provider, credential, model, session, tool, MCP, or subagent systems.

The current implementation ships `omp studio`, a loopback-only Bun server, a
React client shell, a one-time local access token, `GET /api/v1/bootstrap`, a
WebSocket readiness event, SQLite migrations, a persistent workspace registry,
server-side session control leases, an OMP-native provider/auth bridge, and a
supervised OMP RPC session/run lifecycle. The session UI can create a
model-backed local session, acquire a tab-scoped lease, submit a prompt, cancel
an active run, resolve redacted tool approvals, observe subagents and usage,
reconnect with a bounded event cursor, and review a bounded local audit ledger.
All six MVP phases are implemented. The follow-on desktop workbench plan lives
in [Studio Workbench Plan](./studio-workbench-plan.md).

## Goals and Non-Goals

### Goals

- Run only on the local machine for one user, bound to `127.0.0.1`.
- Reuse an active OMP profile and its existing credentials and model registry.
- Let the user connect an OAuth provider, add an API key through OMP, or use a
  keyless local engine before starting a model-backed session.
- Manage registered workspaces, Studio sessions, run state, approvals, and
  audit records without taking ownership of OMP runtime data.
- Stream browser-safe summaries of OMP session events over a versioned
  WebSocket protocol without exposing raw tool arguments, paths, output, or
  provider secrets.

### Non-Goals for the MVP

- Multi-user accounts, LAN exposure, cloud hosting, or remote workers.
- A Studio-managed provider account, credential vault, or model catalog.
- Workflow canvases, Kanban boards, cron jobs, remote file browsing, browser
  terminals, chat channels, or voice. The Electron wrapper was implemented
  after the original MVP and is covered by the Studio Workbench Plan.
- Reimplementing provider OAuth flows or copying Hermes code, assets, or
  branding.

## Architecture

```text
React browser
  -> Studio REST v1 and WebSocket v1
Bun Studio server
  -> Studio SQLite control-plane database
       -> OMP RPC run supervisor
       -> omp --profile <profile> --mode rpc-ui
            -> OMP sessions, AuthStorage, ModelRegistry, tools, MCP, subagents
```

The browser is a display and input surface. It never owns a provider secret,
an arbitrary filesystem path, an OMP session-file path, or direct access to an
OMP RPC child process.

Studio uses the active OMP profile selected by the CLI profile bootstrap. A
named profile therefore gets its own OMP config, credential store, sessions,
and Studio control-plane data. Profile switching is a new `omp studio
--profile <name>` process, not a browser request that changes server state.

## Package Boundary

```text
packages/studio/
  src/protocol/     REST and WebSocket wire types
  src/core/         workspace policy, lease, approval, and run state
  src/server/       Bun server, SQLite, auth bridge, RPC supervisor
  src/client/       React client
  scripts/          deterministic client-asset embedding

packages/coding-agent/
  src/commands/studio.ts
  src/cli/studio-cli.ts
  src/cli/studio-auth-bridge.ts
  src/cli/studio-rpc-transport.ts

packages/utils/src/dirs.ts
  profile-aware Studio directory helpers
```

The initial scaffold may keep small server and client modules directly under
`packages/studio/src`. Phase 2 introduces `src/core/` for the SQLite store and
workspace canonicalization; the package must complete the remaining boundaries
above before the supervisor and persistence implementation grows.

## Data Ownership

| Data | Owner | Studio behavior |
| --- | --- | --- |
| OAuth credentials, API keys, refresh tokens | OMP `AuthStorage` | Drive native login; never persist or return a secret |
| Provider/model catalog and availability | OMP `ModelRegistry` | Present selectable models only |
| OMP JSONL history, blobs, and agent session state | OMP | Keep opaque references server-side |
| Studio workspace registry, run state, leases, approvals, audit | Studio SQLite | Persist as control-plane metadata |
| Local browser access token | Studio process memory | Replace on every Studio restart |

Studio paths must use centralized `@oh-my-pi/pi-utils` directory helpers. The
initial path is `<profile-root>/studio/studio.db`, resolved through the existing
profile and XDG-aware directory resolver. No Studio code may construct a
`~/.omp/...` path itself.

## SQLite Schema

The first persistent implementation creates the following schema through
ordered migrations. Timestamps are UTC epoch milliseconds. IDs are opaque
Studio-generated strings and are never inferred from a path.

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at_ms INTEGER NOT NULL
);

CREATE TABLE studio_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  canonical_path TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE studio_sessions (
  id TEXT PRIMARY KEY,
  profile TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  omp_session_id TEXT,
  omp_session_ref TEXT,
  name TEXT,
  model_provider TEXT,
  model_id TEXT,
  status TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  last_activity_at_ms INTEGER,
  usage_json TEXT,
  usage_updated_at_ms INTEGER
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  studio_session_id TEXT NOT NULL REFERENCES studio_sessions(id),
  status TEXT NOT NULL,
  rpc_protocol_version INTEGER,
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  interrupted_reason TEXT,
  event_sequence INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE control_leases (
  studio_session_id TEXT PRIMARY KEY REFERENCES studio_sessions(id),
  holder_id TEXT NOT NULL,
  issued_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL DEFAULT 'tool',
  arguments_digest TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER,
  resolution_reason TEXT,
  reason TEXT
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  occurred_at_ms INTEGER NOT NULL,
  action TEXT NOT NULL,
  studio_session_id TEXT REFERENCES studio_sessions(id),
  run_id TEXT REFERENCES runs(id),
  detail_json TEXT NOT NULL
);

CREATE INDEX audit_log_session_id_idx ON audit_log(studio_session_id, id DESC);
```

`omp_session_ref` is an opaque server-side reference. It is never returned to
the browser. This schema intentionally has no credential, API-key, OAuth-token,
or raw provider-response columns. Migration 2 adds the usage and approval
metadata above; migration 3 adds the audit-review index. The audit ledger keeps
at most 2,000 newest entries and retains only an allowlisted flat detail shape:
approval ID, arguments digest, model/provider, controlled reason, RPC version,
and tool name. Paths, prompts, raw arguments, tool output, credentials, and
arbitrary nested data are not persisted or returned.

## Local Access and Browser Security

`omp studio` starts on `127.0.0.1` only. It creates a cryptographically random
one-time token and opens a URL such as:

```text
http://127.0.0.1:4317/?token=<one-time-token>
```

The server exchanges a valid token for a process-scoped `HttpOnly`,
`SameSite=Strict` cookie and redirects to `/`, removing the token from the URL.
The token is not stored in SQLite and becomes invalid when the server stops.

All API and WebSocket requests require that cookie. Mutating requests and
WebSocket upgrades additionally reject a supplied `Origin` that is not the
exact Studio origin. Studio sends no CORS headers. There is no default password
because this is not a network service; the loopback binding, unguessable token,
cookie, and origin checks form the local access boundary.

The browser can submit an API key only to its local Studio server over this
authenticated channel. The server passes it directly into the existing OMP
credential flow, redacts it from errors and audit data, and never puts it in a
WebSocket event, response payload, Studio database, or logger field.

## REST Contract

All routes are rooted at `/api/v1`. Successful JSON responses use
`application/json`; failures use this stable shape:

```json
{
  "error": {
    "code": "workspace_not_found",
    "message": "The requested workspace is not registered."
  }
}
```

The current implementation supports bootstrap, workspace registration,
provider onboarding, and supervised sessions. Later routes are reserved now so
the React client and server can evolve without a breaking rename.

| Method and path | Purpose | Phase |
| --- | --- | --- |
| `GET /api/v1/bootstrap` | Server version, active profile, local-access state, and feature availability | 1 |
| `GET /api/v1/workspaces` | List registered workspace summaries | 2 (implemented) |
| `POST /api/v1/workspaces` | Register a canonicalized server-side workspace path | 2 (implemented) |
| `DELETE /api/v1/workspaces/:workspaceId` | Remove a workspace registration when no active run uses it | 2 (implemented) |
| `GET /api/v1/providers` | Provider/account status and available models, with secrets masked | 3 (implemented) |
| `POST /api/v1/providers/:provider/login` | Start an OMP-native OAuth or API-key flow | 3 (implemented) |
| `POST /api/v1/auth/continue` | Submit a paste-code or API-key step to an active OMP-native auth flow | 3 (implemented) |
| `POST /api/v1/sessions` | Create a Studio session for a registered workspace/model | 4 (implemented) |
| `GET /api/v1/sessions` | List Studio session summaries | 4 (implemented) |
| `GET /api/v1/sessions/:sessionId` | Read a session snapshot without exposing OMP paths | 4 (implemented) |
| `POST /api/v1/sessions/:sessionId/lease` | Acquire or renew a tab's session control lease | 4 (implemented) |
| `DELETE /api/v1/sessions/:sessionId/lease` | Release the caller's current session control lease | 4 (implemented) |
| `POST /api/v1/sessions/:sessionId/prompts` | Submit a prompt while holding that session's control lease | 4 (implemented) |
| `POST /api/v1/runs/:runId/cancel` | Cancel the active OMP run while holding its session lease | 4 (implemented) |
| `GET /api/v1/sessions/:sessionId/approvals` | Read redacted approvals for one Studio session | 5 (implemented) |
| `GET /api/v1/sessions/:sessionId/subagents` | Read browser-safe subagent summaries for one Studio session | 5 (implemented) |
| `POST /api/v1/approvals/:approvalId` | Approve or reject one still-valid tool-call approval | 5 (implemented) |
| `GET /api/v1/audit?sessionId=&before=&limit=` | Page bounded browser-safe control-plane audit records | 6 (implemented) |

`POST /api/v1/workspaces` accepts a path only during initial registration. The
server resolves and validates it, stores a canonical path, and returns an
opaque `workspaceId`. Every later request uses that ID. Browser requests never
carry a `cwd`, raw OMP session path, or arbitrary file path.

`GET /api/v1/audit` accepts an optional opaque `sessionId`, a positive opaque
entry cursor in `before`, and `limit` from 1 through 100. The response contains
newest-first records and `nextBeforeId` only when more records remain. This is a
read-only local review surface; audit details are already filtered by the store,
not filtered by the browser.

## WebSocket Contract

The browser connects to `/api/v1/events` after the cookie exchange. The server
uses a single versioned envelope:

```json
{
  "version": 1,
  "sequence": 42,
  "type": "agent.event",
  "emittedAtMs": 1760000000000,
  "studioSessionId": "sts_...",
  "runId": "run_...",
  "data": {}
}
```

The current server emits all v1 lifecycle, approval, subagent, usage, auth, and
recovery events. The complete vocabulary is:

- `studio.ready`: initial readiness and server capabilities.
- `run.state`: lifecycle transition such as `starting`, `running`,
  `interrupted`, or `completed`.
- `agent.event`: a redacted OMP event summary containing only `type`, optional
  `isError`/`isTerminal`, and optional tool-call ID/name. It never includes an
  OMP payload, arguments, paths, output, or message content.
- `approval.requested` and `approval.resolved`: redacted tool metadata and the
  opaque approval ID, tool name, optional safe reason, and SHA-256 argument
  digest. The approval bridge returns only a boolean decision to OMP.
- `subagent.state`: browser-safe lifecycle and aggregate metric summary.
- `usage.updated`: latest OMP token/cost aggregate for a Studio session.
- `auth.progress`: non-secret OAuth/API-key flow progress.
- `studio.resync_required`: the requested reconnect cursor is older than the
  retained event history, so the client must reload REST snapshots.
- `studio.error`: recoverable server-visible error with the same error code
  vocabulary as REST.

The browser does not use WebSocket messages to submit prompts or approvals;
those state-changing operations remain REST requests with lease and origin
checks. A reconnect sends `?after=<last durable sequence>`. Studio retains the
last 256 broadcast events in process memory, sends `studio.ready` first, then
replays newer events in order. If the cursor is ahead of the current process or
falls before the retained window, it sends `studio.resync_required` instead of
silently returning a partial history. `studio.ready` and the resync notice use
the current sequence without advancing it; only broadcast lifecycle events
advance the cursor. The React client retries with exponential backoff and, on a
resync notice, reloads session, approval, subagent, usage, and audit snapshots.

## Provider and Authentication Matrix

| Source | Detection | User action in Studio | Secret ownership | MVP behavior |
| --- | --- | --- | --- | --- |
| Existing OMP OAuth account | OMP `AuthStorage` and `ModelRegistry` | Inspect status and available models | OMP auth store | Supported |
| OAuth browser callback | OMP provider login capability | Start native login, follow provider browser flow | OMP auth store | Supported |
| OAuth paste-code flow | OMP reports a pending continuation | Paste redirect URL into the bound login flow | OMP auth store | Supported |
| Provider API key | OMP login/provider capability | Submit key once to the native OMP validation/store flow | OMP auth store | Supported |
| Environment or `models.yml` credential | `ModelRegistry` availability only | Select an available model | Environment/config, not Studio | Supported, read-only |
| Keyless local engine | OMP model discovery and health | Select a discovered model | No secret | Supported |
| Auth broker | OMP broker-backed `AuthStorage` | Show allowed account status | Broker | Deferred unless already configured |

Studio does not implement provider-specific OAuth endpoints. It drives the
existing OMP auth lifecycle and forwards only structured, non-secret UI steps.
The coding-agent package owns this bridge so Studio cannot create a dependency
cycle back into its host. It discovers the active profile's canonical
`AuthStorage`, builds the native `ModelRegistry`, and maps only provider state,
credential origin, and available-model capabilities into Studio wire types.

Studio holds one in-memory auth flow at a time. `POST /providers/:provider/login`
returns an opaque `ath_...` flow id, while `auth.progress` emits authorization
URLs, instructions, progress, and an optional continuation prompt. The browser
submits a paste-code or API key only to `POST /auth/continue`; its value is
resolved directly into the pending OMP callback, is never written to Studio
SQLite, and is redacted from Studio events and surfaced errors. A provider
that cannot safely complete through that bridge falls back to `omp login
<provider>`; a later `GET /providers` refreshes status.

## OMP RPC Supervisor

Phase 4 starts one supervised child process for each active Studio session:

```text
omp --profile <profile> --mode rpc-ui --model <provider>/<model>
```

The supervisor owns stdin, stdout, stderr, child lifetime, request
correlation, and event fan-out. It negotiates RPC protocol v2 and uses the
existing OMP frame decoder and chunk-reassembly behavior. It must not hand
parse an unbounded JSONL stream.

The supervisor maps Studio IDs to OMP session references internally. It never
lets the browser invoke `switch_session` with a raw session path. A run is
finished only after an `agent_end` where `isTerminal !== false`; a non-terminal
event means the runtime can resume work and must remain active.

The coding-agent transport negotiates RPC v2, requests optional subagent event
delivery, maps `get_session_stats` into Studio usage totals, and handles native
`tool_approval` extension UI requests. Raw tool arguments are held only in a
bounded server-side cache long enough to compute a SHA-256 digest; both that
cache and pending approval state are cleared when the tool/run/session exits.

On a Studio restart, active runs are recorded as `interrupted`. Studio does not
replay prompts, auto-resume a child, or reapprove a tool call. The user chooses
whether and how to resume through a new explicit action. Restart recovery also
rejects pending approvals and clears all persisted control leases because their
browser session capability expired with the Studio process.

## Control Lease and Approvals

Every browser tab gets a random local `holderId` after bootstrap. A tab may
view any local session, but only the tab holding the unexpired control lease
may submit a prompt, cancel a run, change a model, or resolve an approval.
Lease renewal is explicit and fails with `control_lease_held` rather than
silently taking control from another tab.

Phase 2 creates and verifies the persisted lease primitive. Its browser route
arrives with Studio sessions in Phase 4 because the lease is deliberately keyed
to an opaque `studioSessionId`, not a raw workspace path.

An approval records the exact OMP tool-call ID and a digest of the normalized
arguments. It is valid for one decision before expiry. A changed tool-call ID,
changed arguments digest, expired approval, run change, or session change must
be rejected and audited.

## Recovery and Audit

Studio treats the browser event stream as a convenience layer, not the source
of truth. A reconnect replays only the bounded in-memory suffix described above;
the persisted REST session, approval, subagent, usage, and audit snapshots are
authoritative after `studio.resync_required`. A Studio restart starts with a new
cookie/token boundary, interrupts active runtime work, rejects pending tool
approvals, and releases stale leases. It never replays a prompt or manufactures
an approval decision.

The audit ledger records control-plane transitions such as session start,
run state changes, cancellation, approval decisions, and interruptions. It is
local to the selected OMP profile, newest-first, capped at 2,000 rows, and
viewable through the session's Local Audit panel. The server filters every row
detail before it reaches the browser, including detail JSON written by older
versions or a locally modified database.

## Verification Plan

- Contract tests for REST error shape, local cookie exchange, origin rejection,
  workspace ID isolation, control leases, approval expiry, and restart
  interruption.
- RPC fixtures proving v2 negotiation, chunk reassembly, and non-terminal
  `agent_end` behavior, argument redaction, approval expiry, usage, and
  subagent summaries.
- Auth bridge tests covering status discovery and redaction; provider network
  calls use controlled fakes or existing OMP seams.
- A source and compiled-binary smoke probe that starts Studio, exchanges the
  local token, loads the client shell, calls bootstrap, opens WebSocket, and
  receives `studio.ready`.
- Replay tests proving ordered cursor recovery and fail-closed resync when the
  bounded event window is exhausted; audit pagination/filtering and restart
  lease clearing tests.

## Delivery Order

1. Phase 1: package scaffold, loopback server, local access token, client
   shell, embedded static assets, and `omp studio`. (implemented)
2. Phase 2: SQLite migrations, workspace registry, profile-aware Studio paths,
   and control lease. (implemented; session-bound lease API follows Phase 4)
3. Phase 3: OMP auth/model bridge and onboarding. (implemented)
4. Phase 4: RPC supervisor, session lifecycle, tab-scoped control, prompt
   streaming, cancellation, and explicit resume through a later prompt.
   (implemented)
5. Phase 5: tool cards, approvals, subagent visibility, and usage UI.
   (implemented)
6. Phase 6: recovery hardening, audit review, documentation, and release
   verification. (implemented)
