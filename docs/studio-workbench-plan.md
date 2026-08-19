# OMP Studio Workbench Plan

## Status

This is the active product and implementation plan for OMP Studio after the
original local-control-plane MVP. It supersedes the unchecked implementation
checklist in `desktop-app-plan.md`; that document remains useful as historical
Electron packaging context.

Implementation status: Phases 0 through 6 are complete. The workbench,
browser-safe observability and change-review projections, recovery/history
contracts, and Windows-first packaged desktop smoke are now the implemented
baseline. New capability work must start with a separate proposal that preserves
the safety boundary below.

OMP Studio is a local, desktop-first workbench for the OMP coding agent. It is
not a fork of the OMP runtime and it is not a clone of Hermes Studio. OMP keeps
ownership of credentials, providers, models, native sessions, tools, and raw
tool data. Studio owns only local control-plane and browser-safe presentation
state.

## Product Goal

The primary workflow is:

```text
Choose project -> choose or create session -> assign work -> observe the run
-> approve or stop when needed -> review changes -> continue the session
```

At every point the user must be able to answer:

1. What is the agent doing now?
2. What changed in the project?
3. Does the agent need a decision from me?
4. Where can I resume this work safely?

The first release deliberately excludes workflow canvases, Kanban, cloud or
LAN hosting, multi-user accounts, chat channels, voice, browser automation,
and arbitrary filesystem browsing. Those can be reconsidered only after the
single-user coding workflow is reliable.

## Experience Model

The primary view is a three-region workbench, not a dashboard of independent
cards:

```text
+----------------------+--------------------------------------+----------------------+
| Projects and sessions| Conversation and execution timeline  | Run inspector        |
|                      |                                      | - approvals          |
|                      |                                      | - subagents          |
|                      |                                      | - usage              |
+----------------------+--------------------------------------+----------------------+
|                         Composer and active controls                              |
+-------------------------------------------------------------------------------------+
```

The project/session rail preserves context. The conversation remains the
primary reading surface. The inspector answers operational questions without
interrupting the conversation. A later changes drawer will expose a
project-relative change set and sanitized diff summaries.

The visual language should be calm, dense, and work-focused. Status colour is
semantic: active work, completed work, warning/approval, and failure. Avoid
marketing composition, decorative surfaces, and UI controls that cause layout
shift while a run is streaming. The implemented changes and history sections
keep review and recovery in the inspector without taking the conversation out
of the primary reading surface.

## Safety Boundary

The browser never receives an OMP session path, provider secret, raw tool
arguments, raw tool output, native provider payload, or arbitrary filesystem
path. New UI detail must cross this boundary through a server-owned projection:

```text
native OMP event
  -> coding-agent transport redaction
  -> Studio supervisor presentation projection
  -> bounded Studio SQLite presentation state
  -> versioned REST / WebSocket event
  -> React workbench
```

The first projection slice is a durable activity timeline. Its wire shape uses
fixed `subject` and `status` enums rather than free-form native strings. This
makes a tool run visible without disclosing its command, arguments, output, or
path. The completed tool-card, plan, change-review, and history slices continue
that rule: every field is typed, bounded, and projected on the server before it
is persisted or sent to the browser.

## Presentation Contract Roadmap

### Activity Timeline

`StudioActivityEntry` is a browser-safe, persisted summary of one run event.
It contains an opaque Studio ID, Studio session and run IDs, a timestamp, and
fixed presentation enums:

- `subject`: agent, command, file-read, file-write, file-search, web, task,
  context, retry, or generic tool/system work.
- `status`: running, completed, failed, or cancelled.

The client maps these enums to its own static wording. Neither titles nor raw
native tool names are persisted or sent to the browser in this phase.

### Tool Cards

The second slice is a discriminated `StudioToolDisplay` union. Every member is
derived server-side and has a bounded, testable contract. Examples:

- command: redacted command classification and terminal status, never shell
  environment values or unfiltered output;
- file read/search: project-relative path category and bounded sanitized
  snippet only where policy permits it;
- write/edit: project-relative changed-file metadata and bounded diff hunks;
- web: normalized origin/status only until a browser-specific policy exists.

The client must never infer a tool display from an untyped OMP event.

### Changes

The completed change-review slice exposes an explicit change-set endpoint. The
server resolves a registered workspace ID, uses the central coding-agent Git
helper, and returns only validated project-relative files and bounded diff data.
Studio does not spawn Git directly or expose a general filesystem API.

## Delivery Phases

| Phase | Scope | Completion contract |
| --- | --- | --- |
| 0. Product convergence | This roadmap, UX flows, data safety matrix, and document cleanup | The product scope and desktop status have one source of truth |
| 1. Presentation foundation | Activity timeline protocol, storage, REST, WebSocket, and inspector | A reconnect or reload retains safe run activity without leaking raw data |
| 2. Workbench client | Split the current client shell into navigation, conversation, inspector, and composer modules | Session work remains usable across desktop widths and streaming updates |
| 3. Agent observability | Typed tool cards, approval queue, subagent inspector, plan/todo presentation | Users can understand work and act on approvals from one screen |
| 4. Change review | Change-set API, Git summary, changed-file list, diff preview | Users can review project changes before the next instruction |
| 5. Recovery and history | Session search, run history, interrupted recovery, usage/activity views | Restart and event resync never create ghost state or auto-replay work |
| 6. Desktop release | Platform assets, packaging CI, signing/update policy, native smoke coverage | Windows-first packaged Studio starts and shuts down its matched OMP sidecar |

Phases 0 through 3 are the initial workbench release. Workflow canvases,
embedded terminal sessions, direct editing, and multi-agent rooms remain out
of scope until the workbench contracts have proven stable.

## Component Strategy

`packages/studio/src/client/app.tsx` is the integration shell. Implemented UI
behavior is organized into focused modules:

- `shell/`: titlebar, responsive layout, connection state;
- `navigation/`: projects, sessions, search, and session actions;
- `conversation/`: transcript, Markdown, execution timeline, composer;
- `inspector/`: activity, approvals, subagents, usage, and session facts;
- `changes/`: server-projected change-set list and bounded diff preview;
- `history/`, `*-state.ts`, and `presentation.ts`: REST snapshots, WebSocket
  replay, race-resistant merges, and shared browser-safe formatting.

`packages/collab-web` is a useful visual and interaction reference for
transcript, tool-card, and subagent views. Studio must not import its guest
transport or encrypted link protocol. Extract a shared presentation leaf only
after a second concrete consumer proves that a shared abstraction reduces
complexity.

## Verification Rules

- Contract tests cover every newly exposed REST and WebSocket shape.
- A redaction regression test proves sensitive tool arguments and output do
  not appear in persisted timeline rows, API responses, or event payloads.
- Event replay/resync tests prove that REST snapshots restore the authoritative
  activity list after a browser reconnect.
- Activity rows are bounded per session so a long-running agent cannot grow
  Studio SQLite indefinitely.
- Desktop release work must use the existing sidecar smoke contract and test a
  packaged platform-matched OMP executable.

## Current Slice

There is no active implementation phase. The completed baseline includes:

- a responsive navigation, conversation, inspector, and composer workbench;
- browser-safe tool cards, approvals, subagents, plan summaries, change review,
  run history, usage history, session search, and restart recovery;
- bounded server-side projections that preserve the browser safety boundary;
- deterministic desktop assets, a bundled Windows sidecar, and a packaged
  Windows smoke contract in release CI.

The desktop signing and update controls are governed by
[`studio-desktop-release-policy.md`](./studio-desktop-release-policy.md).
