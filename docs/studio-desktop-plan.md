# OMP Studio Desktop Plan

## Status

This is the active implementation plan for `packages/studio-desktop`. It is the
separate proposal that [Studio Workbench Plan](./studio-workbench-plan.md)
requires before new capability work, and it replaces that document's "no active
implementation phase" note for desktop scope. The workbench plan remains
authoritative for `packages/studio` browser-surface phases 0 through 6.

The reference product is Hermes Studio (`packages/desktop` in the
`EKKOLearnAI/hermes-studio` tree). The agreed target is capability parity with
that shell. Parity is measured by what a user can do, not by how the code is
written: where OMP already owns a better mechanism, this plan reaches the same
capability through OMP's mechanism and says so explicitly.

Two decisions are fixed for this plan and constrain every phase below:

1. **No auto-updater.** `electron-updater` is removed rather than enabled.
   Users update by downloading a new installer. See
   [the release policy](./studio-desktop-release-policy.md).
2. **Windows first.** macOS and Linux packaging land in Phase 12, after the
   shell itself is correct on one platform.

## What Exists Today

Verified against the tree at the time of writing; `bun test` in
`packages/studio-desktop` is 42 pass / 0 fail and `tsgo --noEmit` is clean.

| Area | State |
| --- | --- |
| Sidecar lifecycle | `omp studio --no-open --port 0` spawned as a child; ready line parsed and constrained to `127.0.0.1`; 30s timeout; abort on shutdown |
| Startup diagnostics | Bounded stderr tail (20 lines / 400 chars), rotating log under `userData/logs`, error dialog carrying both |
| Window | Framed `BrowserWindow`, `sandbox: true`, `contextIsolation: true`, geometry persisted and clamped to attached displays |
| Navigation policy | Off-origin `will-navigate` and `window.open` deflected to the system browser; CSP injected via `onHeadersReceived` |
| Tray | Show / Hide / Quit, with a fallback that maps close to quit when no tray could be created |
| Preload surface | Three channels: `openExternal`, `selectWorkspace`, `notify` |
| Packaging | `asar`, sidecar staged to `resources/omp-server/`, NSIS target, procedurally generated icons |
| Release verification | `--smoke-test` starts the packaged sidecar, completes the token-to-cookie exchange, reads `/api/v1/bootstrap`, stops, exits |

## Parity Gap Against The Reference

| Capability | Hermes Studio | OMP Studio Desktop today | This plan |
| --- | --- | --- | --- |
| Child process termination | `taskkill /T /F` on Windows, POSIX descendant sweep | `child.kill()` only | Phase 7 |
| Graceful server shutdown | Authenticated `POST /api/desktop/shutdown`, then force kill | None; terminate immediately | Phase 7 |
| IPC sender validation | Rejects any sender that is not the main window | Not checked | Phase 7 |
| Start hidden / quit an existing instance | `--hidden`, `--quit`, single-instance quit request | Neither | Phase 7 |
| Startup feedback | Splash window with staged progress and byte counters | Blank until the sidecar is ready | Phase 8 |
| Startup failure recovery | In-window retry with a source choice | Error dialog then `app.exit(1)` | Phase 8 |
| Main-process localization | 589-line string table for dialogs, tray, splash | English literals inline | Phase 8 |
| Window chrome | Frameless with a rendered titlebar; `hiddenInset` on macOS | OS frame | Phase 9 |
| Window controls | IPC minimize / toggle-maximize / close plus state events | None | Phase 9 |
| Tray menu | Show/Hide toggle, updates, login reset, open-at-login, quit | Show, Hide, Quit | Phase 10 |
| Notifications | Click focuses the window and routes to a validated path | Fire and forget | Phase 10 |
| Text context menu | Copy / paste / select-all on right click | None | Phase 10 |
| Media permission gate | Handler restricted to trusted renderers; macOS prompt | Default handler | Phase 10 |
| Open at login | `setLoginItemSettings` with `--hidden` | None | Phase 10 |
| Managed CLI shims | `hermes-studio`, `… cli`, `… web`, `…-mcp` on PATH | None | Phase 11 |
| Runtime storage choice | User-selectable root, version manifest, migrate/repair | Fixed `resources/omp-server` | Phase 11 |
| Multi-platform release | 5-target matrix with per-platform artifact globs | Windows only | Phase 12 |
| Packaging self-check | `afterPack` verifies the packaged payload | None | Phase 12 |
| Auto-update | Dual feed, prompt, Windows lock recovery | Dependency present, unused | Phase 12 (removed) |
| Detached session windows | Per-session window keyed by profile + session | None | Phase 14 |
| Always-on-top companion window | Pet window, transparent and frameless | None | Phase 14 |
| Embedded terminal | node-pty + xterm, multi-session | None | Phase 15 |
| Embedded agent browser | Multi-tab `WebContentsView`, profiles, proxy, downloads, annotation, agent broker | None | Phase 16 |
| Voice | Microphone capture, STT, TTS, realtime stage | None | Phase 17 |
| Workflow canvas | Node graph over `@vue-flow` | None | Phase 18 |

## Implementation Techniques This Plan Refuses

Capability parity does not extend to these mechanisms. Each one is a measurable
regression against the current shell, so the phase that reaches the same
capability must reach it another way.

| Reference technique | Why it is refused | Replacement |
| --- | --- | --- |
| `sandbox: false` on every window | The renderer loads a full web app; an unsandboxed renderer removes the only process-level containment the shell has | Keep `sandbox: true`; move privileged work behind explicit IPC |
| Preload monkey-patching `window.fetch` and `XMLHttpRequest` to rewrite API responses | A preload that rewrites server responses makes the server contract unverifiable and silently diverges desktop from browser | Change the server projection, or gate on `features` in the bootstrap payload |
| Auth token written to `localStorage` | Readable by any script in the renderer; OMP already has a strictly better exchange | Keep the one-time token to `HttpOnly; SameSite=Strict` cookie exchange |
| `executeJavaScript` to drive splash progress | Injects code into a live document and cannot be typed or tested | Splash is a real preload-backed document fed by one IPC channel |
| Downloading a Python/Node/Git runtime into the user's home on first launch | OMP ships one static platform-matched binary; a downloader adds a supply-chain surface and a failure mode that does not exist today | Keep the bundled sidecar; Phase 11 delivers the *user-visible* capability (storage choice, version visibility, repair) against that binary |
| Auto-update feeds | Fixed decision for this plan | Manual installer download; Phase 12 removes the dependency |

## Safety Boundary

Phases 7 through 12 must not change the browser data boundary defined in the
[workbench plan](./studio-workbench-plan.md): the renderer never receives an OMP
session path, a provider secret, raw tool arguments, raw tool output, a native
provider payload, or an arbitrary filesystem path.

Every new IPC channel added by any phase must satisfy all four rules:

1. Validate that `event.sender` is a window this shell created and that the
   window kind is allowed to call that channel.
2. Validate and bound every argument in the main process. A renderer-supplied
   string is never passed to a shell, a path join, or a URL loader unchecked.
3. Return only data the renderer is already allowed to hold under the boundary
   above.
4. Ship a unit test for the validator, in the pattern of
   `test/external-url.test.ts` and `test/window-state.test.ts`.

Phases 15 through 18 cannot satisfy rule 3 as written, because a terminal, a
browser the agent drives, and a workflow canvas all need data that the boundary
currently forbids. Phase 13 exists to revise the boundary before they start.
No phase after 13 may begin until that revision is written down and reviewed.

## Track A — Shell Correctness (Windows First)

### Phase 7. Lifecycle and process ownership

Status: landed, with one item carried forward.

Done:

- Terminate the sidecar as a process tree. `child.kill()` reaches the root alone,
  so an `omp --mode rpc-ui` child the sidecar spawned per session can outlive the
  app. The force pass is now `taskkill /PID <pid> /T /F` on Windows and a
  deepest-first descendant sweep on POSIX, in `src/main/process-tree.ts`.
- Ask before forcing. POSIX sends `SIGTERM` to the sidecar alone so its own
  handler runs `studio.stop()` → `supervisor.close()` and unwinds session state.
  Windows attempts `taskkill /T` and reports refusal, so a console sidecar that
  cannot accept a graceful close goes straight to the force pass instead of
  waiting out a grace period it will never use.
- Validate `event.sender` on all three IPC channels and reject calls from any
  renderer other than the Studio window.
- Accept `--hidden` (start to tray without showing a window, overridden when no
  tray could be created) and `--quit` (stop a running instance), routed through
  `requestSingleInstanceLock` additional data.
- Remove the unused `electron-updater` dependency.

Measured, not assumed: the orphan was reproduced on a real three-level tree, and
the tree walk clears it. The exposure is platform-dependent. POSIX has no job
objects, so a root-only kill reliably leaks. On Windows the sidecar runtime
happens to place its children in a job object that the OS tears down with the
parent, so the old code was accidentally covered there — the tree walk removes the
dependency on that undocumented behaviour rather than fixing an observed leak.

Carried forward: an authenticated local shutdown request. The OS-primitive
graceful pass above genuinely runs the sidecar's own teardown on POSIX, but
Windows has no equivalent, so a Windows quit still ends in a force kill. Closing
that gap needs a shutdown route in `packages/studio` and its own credential for
the main process, which crosses two packages and belongs in its own change.

Completion contract: tests prove a graceful stop is attempted before any kill,
that a compliant sidecar is never force-killed, that a hung sidecar is still
forced within the timeout, and that force-killing a real tree removes a detached
grandchild that a root-only kill leaves running. Release CI fails if the packaged
smoke test leaves an `omp` process behind.

Not covered: no automated run creates a Studio session and then quits, so the
`omp --mode rpc-ui` case is verified by an equivalent fixture rather than by the
real child. A local `--smoke-test` against the real sidecar leaves no processes
behind, but a smoke run creates no session.

### Phase 8. Startup experience

Scope:

- Create the window immediately with a splash document, before the sidecar is
  spawned. Today `windowManager.create()` runs only after the ready line
  arrives, so a cold start is up to 30 seconds of nothing.
- Feed the splash staged progress through one IPC channel: locating the sidecar,
  waiting for the ready line, exchanging the local token, loading the client.
- Replace the terminal `dialog.showErrorBox` → `app.exit(1)` failure path with an
  in-window failure surface that offers retry, "open log folder", and copy of
  the stderr tail. A failed startup must not require relaunching the app.
- Introduce a main-process string table for every dialog, tray, splash, and
  failure string, with `en` as the base locale. Every later phase adds its
  strings there rather than inlining literals.

Completion contract: a sidecar that cannot start leaves the app running with a
readable reason and a working retry; the smoke test still opens no window.

### Phase 9. Native window chrome

Scope:

- Frameless main window: `frame: false` with `titleBarOverlay` on Windows,
  `titleBarStyle: "hiddenInset"` on macOS, plain frameless on Linux.
- Extend `packages/studio/src/client/shell/titlebar.tsx` into the real window
  chrome: drag region via `-webkit-app-region`, explicit no-drag on every
  control, and minimize / maximize / close buttons that render only when
  `window.ompStudio` is present.
- IPC: `windowControl(action)` and `getWindowState()`, plus a main-to-renderer
  `window-state-change` event for maximize / unmaximize / restore.
- Persist and restore the maximized and fullscreen flags alongside the bounds
  already handled by `window-state.ts`, keeping the display-clamp behaviour.
- Reconcile the desktop CSP with the server's. `window-manager.ts` currently
  overrides the server header and widens `style-src` with `'unsafe-inline'`.
  Either the client stops needing inline styles and the override is dropped, or
  the divergence is documented at the override with its reason.

Completion contract: dragging, double-click-to-maximize, snap, and the OS close
gesture all behave natively on Windows and macOS; the browser-served client is
unchanged when opened outside the desktop shell.

### Phase 10. Operating-system integration

Scope:

- Tray menu: Show/Hide with a label that reflects window visibility, Open at
  login (checkbox), Open log folder, Quit. Keep the existing no-tray fallback.
- `app.setAppUserModelId` on Windows so notifications carry app identity;
  `Menu.setApplicationMenu(null)` off macOS.
- Notifications: `notify` gains an optional target that must validate against an
  allowlisted internal route. Clicking focuses the window and navigates there.
  Hold a reference until close so the notification is not collected early.
- Text selection context menu (copy / paste / select all / copy link).
- Permission handler that denies every permission by default and allows only
  what a named phase has enabled for a renderer this shell created. Phase 17
  is what opens microphone access; until then the handler denies it.
- Open at login registers `process.execPath` with `--hidden` from Phase 7.

Completion contract: every OS affordance is reachable without the main window
visible, and a permission request from an unexpected renderer is denied with a
test that proves it.

## Track B — Distribution and Runtime Management

### Phase 11. Desktop data, runtime visibility, and command shims

Scope:

- Surface the runtime the shell is actually using: sidecar path, version, and
  the profile it resolved. Today this is invisible and only inferable from the
  log. A "Desktop" section in the client reads it over one IPC channel.
- Let the user choose where Studio desktop state lives (window state, sidecar
  log, and the profile root passed to the sidecar), with migration of the
  existing directory and a repair path when the target is unwritable. This is
  the parity answer to the reference's runtime-storage selector, against a
  bundled binary instead of a downloaded venv.
- Repair action: re-verify that `resources/omp-server/omp.exe` exists and is
  executable, and report a clear reinstall instruction when it is not. The app
  must never mutate its own installed sidecar; that is a release-policy rule.
- Managed command shims for the packaged app, matching the reference's model:
  `omp-studio` to open the app, `omp-studio cli …` to run the bundled OMP
  binary, and `omp-studio -h`. Install into a user-writable bin directory,
  mark the shim with a recognizable header, and update the shim rather than
  duplicating it on reinstall. Never modify a system PATH entry.

Completion contract: a user can relocate desktop state, see which sidecar is
running, and invoke the bundled OMP binary from a terminal, on a machine with no
OMP installed globally.

### Phase 12. Multi-platform packaging and update policy

Scope:

- Remove the auto-updater story from the product: delete the dependency
  (Phase 7 already drops it from the bundle), and rewrite the release policy's
  Update Policy section to state permanently that the desktop app has no update
  feed, no background download, and no self-replacement.
- Add an in-app version notice instead: read the current version, link to the
  releases page, and show the checksum expectation. No download, no install.
- Extend the release matrix from one Windows job to five targets — win32-x64,
  darwin-arm64, darwin-x64, linux-x64, linux-arm64 — each downloading only its
  own platform-matched OMP binary and uploading only its own artifact globs.
  A Windows job must not require a macOS artifact and vice versa.
- macOS signing and notarization per
  [`macos-signing-notarization.md`](./macos-signing-notarization.md);
  entitlements for a hardened runtime; Linux `AppImage` plus `deb`.
- `afterPack` verification that fails the build when the packaged tree is
  missing the sidecar, the tray icon, or the preload bundle.
- Run the existing `--smoke-test` contract on every platform that has a runner,
  not only Windows.

Completion contract: a tagged release produces verified installers for all five
targets, each with a matched sidecar, each smoke-tested where a runner exists,
and all listed in `SHA256SUMS.txt`.

## Gate — Phase 13. Presentation boundary revision

Everything in Track C needs data the current boundary forbids. A terminal is raw
process output. A browser the agent drives is raw URLs, page content, and
screenshots. A workflow canvas is task text. Voice is a raw audio stream. None of
these can be projected into fixed enums the way `StudioActivityEntry` is.

This phase produces no user-facing feature. It produces the written revision that
lets the later phases exist without quietly deleting the guarantee that the rest
of Studio was built on. It must decide, and record with a rationale:

- Which new data classes cross into the renderer, and the exact wire type for
  each. "Raw tool output" is not a data class; "PTY byte stream for a terminal
  the user opened in this session" is.
- Whether those classes are allowed in the browser-served client at all, or only
  in the desktop shell. A desktop-only class needs a server-side gate keyed to
  something stronger than a `features` flag the browser also receives.
- What remains categorically excluded. Provider secrets and credential material
  must stay excluded with no exception.
- How the redaction regression test suite changes, since today it asserts the
  absence of exactly the data some of these phases need.
- Whether the audit ledger records these new surfaces, and at what granularity.

Completion contract: an updated safety-boundary section in the workbench plan, a
revised data-ownership table, and a redaction test suite that encodes the new
line rather than the old one. Reviewed and merged before Phase 14 opens.

## Track C — Capability Parity (Gated By Phase 13)

### Phase 14. Multi-window session surfaces

Scope:

- Window kinds. Pass `--omp-window-kind=<main|session|companion>` through
  `additionalArguments`; the preload reads it and exposes only that kind's
  channel subset, as the reference does.
- Detached session windows keyed by Studio session ID, reusing an existing
  window when the same session is requested twice.
- A client route for a single session. The client currently has no router at
  all, so this is a real prerequisite, not a detail: pick hash routing or a
  query parameter, and make session selection survive a reload in both.
- An always-on-top companion window (transparent, frameless, `skipTaskbar`)
  showing live run state for the active session.

Completion contract: a session opens in its own window, survives a reload,
closes independently, and a second request for the same session focuses the
existing window instead of creating a duplicate.

### Phase 15. Embedded terminal

Scope: a workspace-scoped terminal with multiple sessions, resize, and streaming
output. OMP already owns the pieces: `@oh-my-pi/pi-natives` provides shell/PTY
process handling (`docs/natives-shell-pty-process.md`) and `ghostty-web` is
already in the workspace catalog, so this does not need `node-pty` or `xterm`.

Ownership rule: the PTY belongs to the Studio server, not the Electron main
process. The shell must not become a second execution host — that would put a
process spawner behind a preload channel and outside the audit ledger.

Completion contract: a terminal session is created, streamed, resized, and
destroyed through the Studio server; it appears in the audit ledger; and killing
the sidecar kills its PTYs.

### Phase 16. Embedded agent browser

Scope: a multi-tab browser inside the shell that the agent can drive — the
reference's largest desktop feature (about 2,000 lines of main-process code
across manager, broker, profiles, cookies, and annotation).

Sub-scope, in dependency order:

1. Tab host over `WebContentsView` with its own `Session` partition, navigation
   controls, and a viewport the renderer positions.
2. Named profiles: separate partitions, proxy mode (direct / system / fixed),
   download policy, and a switch action that revokes agent access first.
3. Download handling with an explicit conflict policy and a cancel action.
4. Annotation: element and region selection producing a bounded screenshot plus
   numbered markers with notes.
5. Agent access broker with per-tab grants, an explicit user take-over that
   revokes the grant, and revocation on navigate, profile switch, and data clear.

Boundary requirements this phase must honour: every URL the agent navigates to
is audited; a screenshot is a bounded artifact with a size cap, not an unbounded
blob; the agent never receives cookies or storage from a profile; and take-over
is immediate, not best-effort.

Completion contract: the agent can open, navigate, and read a tab it was granted;
the user can take it over and the agent immediately loses access; a proxy or
profile switch revokes all outstanding grants.

### Phase 17. Voice

Scope: microphone capture in the renderer, speech-to-text, text-to-speech
playback, and a turn-taking voice stage for one session.

- This is the phase that opens the microphone in the Phase 10 permission
  handler, for the main and session window kinds only.
- Model hosting belongs to the Studio server, matching the terminal rule.
  `onnxruntime-node` and `@huggingface/transformers` are already in the
  workspace catalog; the reference's `sherpa-onnx` native module and its
  per-platform optional dependencies are not required.
- Audio never persists by default. A transcript is text and follows the normal
  transcript projection; the audio buffer is discarded after transcription
  unless the user explicitly saves it.
- Explicitly out of scope, following the reference's own stated limit: always-on
  wake-word listening and simultaneous full-duplex listen-and-speak.

Completion contract: a spoken turn produces a normal prompt in the transcript,
a spoken reply plays back, denying the permission degrades to text with a clear
reason, and no audio is written to disk without an explicit user action.

### Phase 18. Workflow canvas

Scope: a node graph for composing multi-step agent work, equivalent to the
reference's `@vue-flow` canvas but in React, since the Studio client is React 19.

This phase is last for two reasons. It is the only Track C item that is a
product-design question rather than a shell question — what a node is, what an
edge means, and how a graph maps onto Studio runs and sessions has no answer in
the current protocol. And the workbench plan currently lists workflow canvases as
explicitly out of scope, so this phase must amend that document rather than
contradict it.

Completion contract: a graph is authored, persisted, executed against real runs,
and its per-node state is observable in the existing inspector; the workbench
plan's non-goal list is updated in the same change.

## Verification Rules

Carried forward from the workbench plan and extended for the shell:

- Every IPC validator has a unit test. `external-url.test.ts` and
  `window-state.test.ts` are the pattern: pure functions extracted from the
  Electron surface, tested without launching Electron.
- Every supervision behaviour — ready line, timeout, abort, early exit, shutdown
  handshake, force-kill — is tested against a fake sidecar process, as
  `studio-server.test.ts` already does.
- The packaged `--smoke-test` contract is extended, never replaced. Any phase
  adding a startup step adds an assertion there.
- A process-leak check runs after the smoke test on Windows and fails if an
  `omp.exe` remains.
- Redaction regression tests are updated in the same change as any boundary
  revision, never after it.

## Open Items Before Phase 7

Resolved. `packages/studio` is green again: `src/client/hydration-state.ts` and
`src/client/inspector-demand.ts` now exist and are wired into `app.tsx`, so
inspector snapshots are fetched for the visible panel only and usage-history
refreshes coalesce instead of firing per streamed response.

The remaining piece of that client split is `TranscriptRequestOwnership`, which is
implemented and tested but not yet adopted by `loadTranscript`. Adopting it
replaces the per-session request-id guard with real request cancellation and
changes transcript loading to single-owner semantics, which touches pagination —
it is a focused follow-up rather than part of the desktop track.

## Scope Reality

Track A is four focused phases against a shell that is already ~600 lines and
well factored. Track B is packaging and policy work with a known shape.

Track C is a different order of magnitude. In the reference, the four
capabilities in phases 15 through 18 account for the majority of its desktop and
client code, and three of the four are currently listed as non-goals in the
workbench plan. They are in this plan because full parity was the chosen target,
and the phases are ordered so that each one can be deferred at its boundary
without stranding the phase before it.

Phase 7 has landed. Its value turned out to be narrower than expected — the
Windows orphan the phase was written for is masked by the sidecar runtime's job
objects — but the POSIX leak was real, the tree walk removes the dependency on
undocumented runtime behaviour, and the shell now asks before it forces. Phase 8
is next.

