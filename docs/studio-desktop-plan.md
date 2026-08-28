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
`packages/studio-desktop` is 183 pass / 0 fail and `tsgo --noEmit` is clean.

| Area | State |
| --- | --- |
| Sidecar lifecycle | `omp studio --no-open --port 0` spawned as a child; ready line parsed and constrained to `127.0.0.1`; 30s timeout; abort on shutdown |
| Startup diagnostics | Bounded stderr tail (20 lines / 400 chars), rotating log under `userData/logs`, error dialog carrying both |
| Window | Frameless `BrowserWindow` with native caption buttons on Windows and macOS, `sandbox: true`, `contextIsolation: true`, geometry, maximized, and fullscreen persisted and clamped to attached displays |
| Window chrome | Client-rendered title bar: drag region, OS-reserved caption area kept clear, rendered controls only where the OS draws none |
| Navigation policy | Off-origin `will-navigate` and `window.open` deflected to the system browser; the server's CSP header applies unmodified |
| Tray | Show/Hide toggle, open at login, open log folder, quit; rebuilt on visibility change, with a fallback that maps close to quit when no tray could be created |
| OS integration | Windows AUMID set, no application menu off macOS, right-click text and link menu, notifications that focus the window on click, deny-by-default permission handler |
| Preload surface | Six channels: `openExternal`, `selectWorkspace`, `notify`, `getWindowState`, `windowControl`, `onWindowStateChange` |
| Packaging | `asar`, sidecar staged to `resources/omp-server/`, NSIS target, procedurally generated icons |
| Release verification | `--smoke-test` starts the packaged sidecar, completes the token-to-cookie exchange, reads `/api/v1/bootstrap`, stops, exits |

## Parity Gap Against The Reference

| Capability | Hermes Studio | OMP Studio Desktop today | This plan |
| --- | --- | --- | --- |
| Child process termination | `taskkill /T /F` on Windows, POSIX descendant sweep | `child.kill()` only | Phase 7 |
| Graceful server shutdown | Authenticated `POST /api/desktop/shutdown`, then force kill | `child.kill()` only | Phase 7 (stdin control channel instead) |
| IPC sender validation | Rejects any sender that is not the main window | Not checked | Phase 7 |
| Start hidden / quit an existing instance | `--hidden`, `--quit`, single-instance quit request | Neither | Phase 7 |
| Startup feedback | Splash window with staged progress and byte counters | Blank until the sidecar is ready | Phase 8 |
| Startup failure recovery | In-window retry with a source choice | Error dialog then `app.exit(1)` | Phase 8 |
| Main-process localization | 589-line string table for dialogs, tray, splash | English literals inline | Phase 8 |
| Window chrome | Frameless with a rendered titlebar; `hiddenInset` on macOS | Frameless with a rendered titlebar, native caption buttons kept | Phase 9 (done) |
| Window controls | IPC minimize / toggle-maximize / close plus state events | IPC minimize / toggle-maximize / close plus state events | Phase 9 (done) |
| Tray menu | Show/Hide toggle, updates, login reset, open-at-login, quit | Show/Hide toggle, open-at-login, log folder, quit | Phase 10 (done) |
| Notifications | Click focuses the window and routes to a validated path | Click shows and focuses the window | Phase 10 (done); route in Phase 14 |
| Text context menu | Copy / paste / select-all on right click | Cut / copy / paste / select-all / copy link | Phase 10 (done) |
| Media permission gate | Handler restricted to trusted renderers; macOS prompt | Deny-by-default handler, empty allowlist | Phase 10 (done) |
| Open at login | `setLoginItemSettings` with `--hidden` | `setLoginItemSettings` with `--hidden` | Phase 10 (done) |
| Managed CLI shims | `hermes-studio`, `… cli`, `… web`, `…-mcp` on PATH | None | Phase 11 (done) |
| Runtime storage choice | User-selectable root, version manifest, migrate/repair | Fixed `resources/omp-server` | Phase 11 (done) |
| Multi-platform release | 5-target matrix with per-platform artifact globs | Windows only | Phase 12 (done) |
| Packaging self-check | `afterPack` verifies the packaged payload | None | Phase 12 (done) |
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

Status: complete.

Done:

- Terminate the sidecar as a process tree. `child.kill()` reaches the root alone,
  so an `omp --mode rpc-ui` child the sidecar spawned per session can outlive the
  app. The force pass is now `taskkill /PID <pid> /T /F` on Windows and a
  deepest-first descendant sweep on POSIX, in `src/main/process-tree.ts`.
- A graceful stop that works on Windows. The sidecar runs a stdin control channel
  when the shell supervises it: a `shutdown` line stops the server through
  `studio.stop()` → `supervisor.close()`, and a closed channel stops it too, so a
  sidecar cannot outlive a shell that crashed without cleaning up. The sidecar
  announces the channel on stdout before its ready line, so a sidecar built
  before the channel existed is signalled immediately instead of being waited on.
- Signal and force fallbacks behind that: `SIGTERM` to the sidecar alone on POSIX,
  `taskkill /T` on Windows with refusal reported, then the tree-wide force pass.
- Validate `event.sender` on all three IPC channels and reject calls from any
  renderer other than the Studio window.
- Accept `--hidden` (start to tray without showing a window, overridden when no
  tray could be created) and `--quit` (stop a running instance), routed through
  `requestSingleInstanceLock` additional data.
- Remove the unused `electron-updater` dependency.

The graceful stop deliberately does not use the shutdown route this plan
originally called for. An HTTP route would need its own credential in the sidecar's
environment, readable by any same-user process, to guard an endpoint whose only
power is stopping a local app. The stdin channel needs no credential, adds no HTTP
surface, is unreachable by any process that is not the shell, and additionally
gives the shell-crash case a fix that no amount of care in the shell can: the
sidecar notices its channel closed and stops itself.

Measured, not assumed: the orphan was reproduced on a real three-level tree, and
the tree walk clears it. The exposure is platform-dependent. POSIX has no job
objects, so a root-only kill reliably leaks. On Windows the sidecar runtime
happens to place its children in a job object that the OS tears down with the
parent, so the old code was accidentally covered there — the tree walk removes the
dependency on that undocumented behaviour rather than fixing an observed leak.

Completion contract: tests prove the control-channel request stops a sidecar
without any signal, that a sidecar predating the channel is signalled rather than
waited on, that a signalled sidecar is never force-killed, that a hung sidecar is
forced within the timeout, and that force-killing a real tree removes a detached
grandchild a root-only kill leaves running. The source sidecar was verified to
announce the channel before its ready line and to exit 0 on request. Release CI
fails if the packaged smoke test leaves an `omp` process behind.

Not covered: no automated run creates a Studio session and then quits, so the
`omp --mode rpc-ui` case is verified by an equivalent fixture rather than by the
real child.

### Phase 8. Startup experience

Status: complete.

Done:

- The window is created with a splash document before the sidecar is spawned.
  Startup previously created it only after the ready line, so a cold start showed
  nothing for as long as the sidecar took, up to its 30-second timeout.
- Staged progress over one channel: locating the runtime, starting the local
  server, opening the workbench. The splash is a real document on disk with its
  own strict CSP meta policy, fed typed state through the preload — the shell
  never evaluates script in that window.
- The terminal `dialog.showErrorBox` → `app.exit(1)` path is gone. A failed
  startup now renders in the window with the reason, the sidecar's stderr tail,
  the log path, and retry / open-log-folder / copy-details actions. Retry
  re-enters the same startup function, stopping any half-started sidecar first.
- A main-process string table with `en` as the base locale. Dialog, tray, splash,
  and failure text all resolve through `t()`; later phases add keys there.
- Splash channels are rejected once the Studio client owns the window. The window
  keeps one preload across both documents, so that check is where the boundary
  actually holds.

Found while verifying: `omp studio` outlived its own shutdown whenever a tab was
connected. `server.stop()` drained active connections instead of closing them, and
the event WebSocket an idle tab holds open never closes on its own — so the process
survived its own stop until the shell's force pass killed it. Measured at 5,783ms
to stop a sidecar with one connected client, 30ms after the fix, and a full desktop
quit went from 6,829ms to 2,354ms. Fixed in `packages/studio`.

Completion contract: a sidecar that cannot start leaves the app running with a
readable reason and a working retry — verified live with a bogus executable path,
where the app stayed up and reported `ENOENT` with its log path instead of exiting.
The smoke test still opens no window.

### Phase 9. Native window chrome

Status: complete.

Done:

- The main window is frameless. `titleBarStyle: "hidden"` with `titleBarOverlay` on
  Windows, `hiddenInset` with the overlay enabled on macOS, plain `frame: false`
  on Linux, resolved by platform in `src/main/window-chrome.ts`.
- Windows and macOS keep their **native** caption buttons rather than rendered
  imitations. That is what preserves the Windows 11 snap-layout flyout on maximize
  hover and the macOS traffic lights, neither of which a custom button can offer.
  The client renders its own three controls only where the OS draws none.
- `packages/studio/src/client/shell/titlebar.tsx` is the window chrome now: the
  header is the drag region, every anchor, button, input, and select inside it
  opts out with `-webkit-app-region: no-drag`, and the caption-button area the OS
  reserves is kept clear through the `titlebar-area-*` environment variables.
  Double-click-to-maximize is native where the OS controls are; on a plainly
  frameless window it is reproduced in the client, ignoring double-clicks that
  landed on a control.
- IPC `window-control` and `window-state`, plus a main-to-renderer
  `window-state-change` event for maximize, unmaximize, and both fullscreen
  transitions — so a snap gesture or an OS shortcut updates the rendered chrome.
  `close` goes through `close()`, not `destroy()`, so the rendered button behaves
  exactly like the OS one: to the tray when a tray exists, quit when it does not.
- The maximized and fullscreen flags persist beside the bounds, and the saved size
  is now `getNormalBounds()` rather than `getBounds()`, so unmaximizing after a
  restart returns to where the user left the window.
- The desktop CSP override is gone rather than documented. It had widened the
  server's header with `'unsafe-inline'` styles, `blob:` images, and cross-port
  `http://127.0.0.1:*`, and dropped `base-uri` and `frame-ancestors` along the
  way. The client needs none of it, so the server's header — the stricter one — is
  what applies on both surfaces, and a policy change now happens in one place.

Measured, not assumed, against Electron 33 on Windows 11:

- The chrome window's `getBounds()` equals its `getContentBounds()`, where a framed
  window of the same size differs by 39px of caption and 8px of border. There is no
  OS title bar left to draw over.
- `navigator.windowControlsOverlay` reports visible with a 56px-tall title bar
  area, matching `TITLEBAR_HEIGHT`. In a 900px window the caption buttons take the
  rightmost 136px, and the client's padding rule computes to exactly `136px` — the
  reserved space is right rather than guessed.
- `-webkit-app-region` resolves to `drag` and `no-drag` from a served stylesheet
  under `style-src 'self'`, so the drag regions need no CSP widening.
- `getNormalBounds()` still reported the pre-maximize rectangle while the window
  was maximized and while it was fullscreen; `getBounds()` reported the maximized
  `-8,-8 1936x1048`. Persisting current bounds would have saved that overhang as
  the restore size.
- A CSSOM style write applies under `style-src 'self'` while the same value set as
  a `style` attribute is blocked. That is the distinction that makes dropping
  `'unsafe-inline'` a no-op here: the client's only runtime style write is the
  composer's textarea height, and its markdown renderer escapes raw HTML, so no
  style attribute ever reaches the DOM.

Completion contract: the frameless window, the overlay geometry, and the restore
bounds are measured above. The browser-served client is unchanged — every chrome
behaviour hangs off classes and elements that appear only when `window.ompStudio`
answers, and a shell that does not answer leaves the title bar exactly as it was.

Not covered: dragging, snapping, and the OS close gesture are native behaviours of
the resolved options rather than shell code, and were not driven by hand in a
window this environment can display. macOS resolves to `hiddenInset` but has not
run.

### Phase 10. Operating-system integration

Status: complete, with one item moved to Phase 14.

Done:

- Tray menu: a single Show/Hide item whose label reflects whether a window is on
  screen, an Open-at-login checkbox, Open log folder, and Quit. Two separate
  Show and Hide items meant one of them was always a no-op with nothing in the
  menu to say which. The menu is rebuilt whenever the window's visibility
  changes, so it cannot describe a state the window has left. The existing
  no-tray fallback is unchanged.
- Open at login registers `process.execPath` with `--hidden` from Phase 7, so a
  login start goes to the tray instead of taking the foreground on every boot.
  The checkbox is omitted where it could not work: Linux, where Electron writes
  no login item at all, and any unpackaged run, where the registered executable
  would be Electron rather than Studio.
- `app.setAppUserModelId` on Windows. A notification is attributed to an AUMID,
  not to a process, so without it a toast is labelled with the Electron
  executable and cannot be muted or found under OMP Studio. A test compares the
  constant against `appId` in `electron-builder.yml`, since a mismatch is
  invisible at runtime and silently drops every toast.
- `Menu.setApplicationMenu(null)` off macOS. A frameless window that draws its
  own title bar has no use for a menu bar above it; macOS keeps its menu, which
  is where that platform's Cmd+C, Cmd+V, and Cmd+Q live.
- Notifications are no longer fire-and-forget: clicking one shows and focuses the
  window, restoring it first if it was minimized. Each notification is held until
  it closes — one collected while still on screen takes its click handler with it.
  Title and body are now validated and bounded rather than only type-checked:
  control characters stripped, titles collapsed to one line, and both truncated,
  because the OS draws them outside any window the shell controls.
- Right-click menu for text and links: cut, copy, paste, and select-all as roles
  so they carry the OS's own labels, plus Copy link address. Items appear only
  when they would do something, and a click that would produce an empty menu
  shows none. Off macOS there is no application menu, so this is the only route
  to copy and paste, not a convenience. Link URLs go through the same validator
  as an external launch: copying a `javascript:` or `file:` URL is the first half
  of an attack that ends with the user pasting it somewhere that runs it.
- Permission handler that denies everything. Electron's default allows most
  requests, so a document in the shell could have reached the microphone or the
  clipboard read API with no code here having decided. Both the request handler
  and the check handler are installed — the latter answers
  `navigator.permissions.query`, which would otherwise report a permission as
  granted that the request handler is about to refuse. The allowlist is empty and
  a test asserts it: Phase 17 is what adds `media`, and the test fails if a
  permission is granted without a phase behind it.

Moved to Phase 14: the notification's *validated target route*. Clicking focuses
the window, which is the half that was broken. Routing to a path needs paths, and
the client has no router at all — Phase 14 already owns creating one. Adding an
allowlist of routes now would validate against a set with exactly one member, the
app root, and navigating there means reloading the whole client.

Measured, not assumed: `Menu.buildFromTemplate` accepts both resolved templates on
Electron 33, the four edit roles come back labelled by the OS rather than blank,
the tray icon loads and `setContextMenu` is accepted, and `getApplicationMenu()`
reads null after the call. Unit tests cover the tray labels and ordering, the
context-menu rules, the login-item settings per platform, the notification bounds,
and the permission denials.

Completion contract: with no window on screen the tray reaches show, open at
login, the log folder, and quit. A permission request from a renderer this shell
did not create is denied by `permissions.test.ts`, which asserts it for every
permission Chromium currently defines plus an unknown one.

Not covered: no automated run clicks a real toast, and the Windows AUMID
attribution can only be confirmed against an installed build, not a dev run.

## Track B — Distribution and Runtime Management

### Phase 11. Desktop data, runtime visibility, and command shims

Status: complete.

Done:

- A "Desktop" section in the setup drawer that shows the runtime the shell is
  actually using: the sidecar binary path, the version (from the bootstrap
  payload's `runtimeVersion`), the profile, the effective state root, the OMP
  config root the sidecar runs under, the sidecar log path, and the shim's
  install state. All five new channels validate the sender before touching a
  path, and the client re-validates the payload (`parseStudioDesktopRuntime`)
  so a shell whose version differs degrades to no section rather than rendering
  paths that are not real.
- A user-relocatable state root. The pointer is stored in the platform-default
  userData dir, because a pointer cannot live inside the movable root. An
  unwritable saved root falls back to the default for this launch instead of
  failing startup and reports `storageRepaired`, which is what lets the section
  offer the repair. Relocation migrates the desktop-owned state (window
  geometry, log tree) and, into a fresh root, the OMP config the sidecar
  currently runs under; the copy never clobbers an existing target entry, and a
  root the user has moved back to is left exactly as it is.
- Relocation is a relaunch, with a commit point: the new pointer is written
  first, then the sidecar is stopped, then the state is migrated, then
  `app.relaunch()` + `app.quit()`. Electron's relauncher waits for the old
  process to fully exit, so the single-instance lock cannot be re-taken while
  the old instance still holds it.
- A sidecar repair check: verifies the bundled binary is present (and
  executable off Windows) and reports a reinstall instruction with a link to
  the releases page when it is not. Purely a read — the release policy forbids
  the app from mutating its own installed sidecar.
- Managed `omp-studio` shims for the packaged app: no arguments opens the app,
  `cli …` runs the bundled OMP binary, `-h`/`--help` shows usage. Installed into
  a user-writable bin directory that is already on the default PATH (the
  per-user WindowsApps dir on Windows, `~/.local/bin` on Linux), owned by a
  header marker on its first two lines, updated in place when the marker is
  present, and never clobbering a file without it. No PATH entry is ever
  modified. Installed at startup (packaged only — a dev run would write a shim
  pointing at the dev binary) and re-runnable from the section.

Found while verifying: three defects, all fixed before the phase closed.

- Relocation would have migrated the wrong config source. The sidecar honors an
  absolute `OMP_CONFIG_ROOT` environment variable, but the migration source was
  computed from `PI_CONFIG_DIR` / `~/.omp` alone — a relocated user who had set
  `OMP_CONFIG_ROOT` would have had their state moved from a root their sidecar
  was not using. Fixed by making the sidecar's own resolution the single source
  of truth: `defaultConfigRoot` applies the `OMP_CONFIG_ROOT` override
  (absolute only, empty ignored), and the relocation handler migrates from the
  config root this launch actually runs under.
- Relocation copied a live SQLite database. The config root holds session
  databases the running sidecar keeps open in WAL mode; a file-by-file copy of
  the `.db` and `.db-wal` pair could land as an inconsistent pair in the new
  root. Fixed by stopping the sidecar before the copy — and by ordering the
  handler so the pointer write is the commit point *before* the irreversible
  stop: a failure after the pointer write leaves the app on the old root with
  the new pointer (the next launch re-migrates an empty root, losing nothing)
  rather than on the new root with a stopped sidecar.
- The shim's argument loop dropped an empty argument and everything after it.
  `if "%~1"==""` expands `%1`, so a user's `""` (two characters) and an
  exhausted argument list (zero characters) are indistinguishable. Fixed with
  `set "T=%1"` + `if not defined T goto :cli-run`: a zero-length `%1` clears the
  variable, a `""` argument leaves it defined, and — unlike comparing `%1`
  directly in the `if` — a quoted value cannot unbalance the comparison's
  quotes.

Measured, not assumed: the shim terminator was verified against a real `cmd`,
not a fixture — no arguments opens the app, `--foo` reaches the sidecar as
`--foo`, `--foo "" --bar` keeps the empty argument, `--foo "bar baz" --bar`
keeps the multi-word quoting, and `--foo --bar` is not truncated. The first fix
attempt (raw `%1` inside the `if`) itself broke the quoted case, which is why
the `set`/`defined` pair is the shipped shape. Unit tests cover the storage
validator (including the explicit-platform absoluteness checks), the
never-clobber migration copies, the `defaultConfigRoot` override, the shim
render/plan/install, and the client-side runtime payload validator.

Completion contract: a user can relocate desktop state, see which sidecar is
running, and invoke the bundled OMP binary from a terminal, on a machine with no
OMP installed globally. `bun test` in `packages/studio-desktop` is 225 pass /
0 fail and in `packages/studio` 91 pass / 0 fail; `tsgo --noEmit` is clean in
both.

Not covered: no automated run completes a relocation of an installed app — the
migration copy and the relaunch are tested against fixtures, not a live install.
Shim invocation is verified with a sidecar that echoes its arguments rather
than the real binary; the real binary receives a proper argv, so the batch
layer, which re-tokenizes, is the layer that needed the empirical check. The
Phase 12 packaging work (afterPack self-check, notarization, entitlements, the
multi-target builder config) is already staged in the tree ahead of this phase's
close but is verified and recorded under Phase 12.

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

Status: complete.

Done:

- The auto-updater story is gone: `electron-updater` is no longer a dependency
  (Phase 7 dropped it from the bundle; the package no longer lists it), and the
  release policy's Update Policy section now states permanently that the
  desktop app has no update feed, no background download, no silent install,
  and no self-replacement of the application or its sidecar. The decision is
  load-bearing: reintroducing the feed requires reversing that section first.
- An in-app version notice replaces it: the Desktop section of the setup drawer
  shows the running `runtimeVersion` (from the bootstrap payload) and a release
  notice that links to the GitHub release page and states the checksum
  expectation. It downloads and installs nothing.
- The release matrix goes from one Windows job to five targets — win32-x64,
  darwin-arm64, darwin-x64, linux-x64, linux-arm64. Each leg downloads only its
  own platform-matched OMP binary and uploads only its own artifact globs (NSIS
  on Windows, dmg plus zip on macOS, AppImage plus deb on Linux). A Windows leg
  never needs a macOS artifact and vice versa, and `release_github` gates the
  publish on all three desktop legs succeeding, so a release cannot publish a
  target whose leg failed.
- macOS signs and notarizes per `macos-signing-notarization.md`: a hardened
  runtime with the three entitlements the Bun sidecar needs, the Developer ID
  certificate handed to electron-builder via `CSC_LINK`, and an afterSign hook
  that runs `notarytool submit --wait` then `stapler staple` when the Apple
  credential set is present and skips cleanly when it is not.
- An `afterPack` self-check fails the build when the assembled tree is missing
  the platform-matched sidecar, the tray icon, or the two bundled scripts, or
  carries a foreign-architecture sidecar — a missing sidecar becomes a build
  error instead of a first-launch failure for a user.
- The `--smoke-test` contract runs on every platform that has a runner, not
  only Windows: the macOS and Linux legs launch the packaged app under an
  isolated `HOME`/`XDG_DATA_HOME` (under `xvfb` on Linux), and each upload step
  errors when no artifact is present.

Found while verifying: four defects, all fixed before the phase closed.

- The macOS `afterPack` resolved the wrong resources directory — it dropped the
  `<app>.app` segment, so every darwin leg would have failed its own packaging
  check on a correctly assembled tree. Fixed to resolve
  `<appOutDir>/<productFilename>.app/Contents/Resources`, matching
  app-builder-lib's `getMacOsResourcesDir` and the layout `notarize.cjs`
  already uses; a regression test now drives `afterPack(context)` with a mock
  darwin context.
- The Windows build script deleted the sidecar destination before copying it
  when a dev run pointed `OMP_STUDIO_OMP_EXECUTABLE` at the already-staged
  binary, then failed with `ENOENT` from the path it had just removed. Fixed
  with a source/destination identity check, and the script now drops both
  sidecar names before copying so a repackage on the other architecture cannot
  leave a stale binary beside the new one.
- The root `package.json` carried `sherpa-onnx*` as regular dependencies even
  though the only consumer (`packages/coding-agent`) declares its own; because
  bun hoists to the repo root, electron-builder's traversal collector read the
  root manifest and threw on the platform-specific leaves absent on a Windows
  host. Removed the three root dependencies; `bun.lock` shrank accordingly.
- The publish gate and the Linux smoke each had a gap that would have shipped
  a broken or missing artifact: `release_github`'s `if` required the Windows
  desktop leg but not the macOS or Linux legs, so a failed arch could publish a
  release missing that installer; and the Linux smoke passed
  `HOME=`/`XDG_DATA_HOME=` as arguments to `xvfb-run` instead of environment
  assignments, so the app was never launched under the intended isolation.

Measured, not assumed: `bun test` is 230 pass / 0 fail in
`packages/studio-desktop` (21 files) and 91 pass / 0 fail in `packages/studio`
(16 files); `tsgo --noEmit` is clean in both. The `afterPack` self-check was
driven against a real electron-builder context on Windows and correctly refused
to publish a tree missing its sidecar. The five-target matrix, the per-leg
download/upload globs, and the publish gate were checked by reading the workflow
and a structured review whose confirmed findings are the four defects above.

Completion contract: a tagged release produces verified installers for all five
targets, each with a matched sidecar, each smoke-tested where a runner exists,
and all listed in `SHA256SUMS.txt`.

Not covered: the cross-architecture and installer-producing runs are
CI-runner-bound and were not executed on this machine. Building a
platform-matched `omp` sidecar compiles the coding-agent against a Bun
cross-target runtime this host could not download, so the full `--smoke-test`
with a real sidecar, the macOS `codesign`/`stapler` verification, and `afterPack`
on a darwin tree each run only where their runner exists (`macos-14`,
`macos-15-intel`, `ubuntu-22.04`, `ubuntu-24.04-arm`). The `afterPack` mac
resolution is covered by a unit test against a mock darwin context rather than a
live darwin build; the Linux `xvfb` smoke and the macOS signing path are
exercised by the workflow steps themselves, not locally.

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
- The notification target Phase 10 deferred: `notify` gains an optional route,
  validated in the main process against the routes this phase creates, and
  clicking the notification lands on it rather than only focusing the window.
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

Phase 7 is complete. Its value turned out to be narrower than expected — the
Windows orphan the phase was written for is masked by the sidecar runtime's job
objects — but the POSIX leak was real, the tree walk removes the dependency on
undocumented runtime behaviour, and the shell now has a graceful stop that works
on Windows. Phase 8 is complete too, and turned up a real shutdown defect in
`packages/studio` on the way. Phase 9 is complete: the window is frameless, the
client draws its own title bar, and the desktop stopped keeping a second, weaker
copy of the browser surface's Content-Security-Policy. Phase 10 is complete, which
finishes Track A — the shell's OS surface is now deny-by-default for permissions
and every tray affordance works with no window on screen.

Phase 11 is complete, and it is the first of Track B: the desktop now shows the
runtime it is using, the state root is user-relocatable with a repair path for
an unwritable root, the sidecar is checkable read-only, and a managed shim makes
the bundled OMP binary callable from a terminal on a machine with no global OMP
install. Three defects found during verification — a wrong migration source, a
live SQLite copy, and a shim that dropped empty arguments — were fixed and
re-verified before the phase closed, which is the point of the measured-not-
assumed rule for a phase whose whole subject is moving the user's data.

Phase 12 is complete. It opened with its packaging artifacts already staged in
the tree, and verification surfaced four more defects — a macOS `afterPack`
path that dropped the `.app` segment, a Windows build script that deleted the
sidecar it was about to copy, root `sherpa-onnx*` dependencies that broke the
packager's dependency walk, and a publish gate plus a Linux smoke that could
have shipped a release missing a target. All four were fixed and re-verified
before the phase closed. Track A and Track B are now finished; the next work is
the Phase 13 presentation-boundary revision, which Track C's phases 14 through
18 depend on.

