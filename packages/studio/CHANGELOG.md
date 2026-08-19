# Changelog

## [Unreleased]

### Added

- Added a browser-safe, durable run activity timeline for the Studio workbench.
- Added the responsive Studio workbench with modular navigation, conversation,
  inspector, composer, tool cards, approval controls, subagent summaries, and
  plan presentation.
- Added bounded server-projected change review, session search, durable run and
  usage history, and interrupted-session recovery without automatic replay.
- Added the local single-user OMP Studio scaffold.
- Added SQLite-backed workspace registration, persistent control-lease primitives, and the Phase 2 workspace ledger UI.
- Added OMP-native provider discovery and OAuth/API-key onboarding with redacted authenticated event progress.
- Added the Phase 4 supervised OMP RPC session lifecycle, durable run state, tab-scoped session control, prompt/cancel endpoints, and live event-stream UI.
- Added Phase 5 tool approval cards, browser-safe subagent and usage summaries, and lease-gated approval decisions.
- Added Phase 6 reconnect cursors with bounded replay/resync recovery, stale-lease clearing on restart, and a paginated local audit review ledger.

### Fixed

- Fixed Studio session startup and retry feedback, provider-error recovery guidance, and removal of idle projects with their Studio-only history.
- Fixed Studio chat stalls caused by unbounded transcript updates, stale WebSocket reconnects, and forced scrolling during streaming.
- Fixed stale run locks and setup overlays that could leave the chat composer unusable after a desktop restart, and added bounded mutation requests with automatic state recovery.
