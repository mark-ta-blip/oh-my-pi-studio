# Changelog

## [Unreleased]

### Added

- Added the initial Electron desktop shell for OMP Studio with a supervised OMP sidecar, secure preload bridge, tray controls, window state persistence, and platform build targets.
- Added deterministic app and tray assets, Windows NSIS packaging validation,
  and a packaged sidecar smoke test that verifies local token exchange and
  authenticated bootstrap before shutdown.
- Added `--hidden` to start OMP Studio in the tray without showing a window, and
  `--quit` to stop an already-running instance.
- Added a splash window that opens before the sidecar is spawned and reports what
  startup is waiting for, replacing an empty screen that could last as long as the
  sidecar's ready timeout.
- Added a recoverable startup failure surface. A sidecar that cannot start now
  leaves the app running with the reason, the sidecar's own last output, the log
  path, and working retry, open-log-folder, and copy-details actions. Startup no
  longer ends in a modal dialog and an exit.
- Added a frameless main window whose title bar is drawn by the Studio client.
  Windows and macOS keep their native caption buttons, so the Windows 11 snap
  layouts and the macOS traffic lights still work; a plainly frameless window gets
  minimize, maximize, and close from the client instead. New `windowControl`,
  `getWindowState`, and `onWindowStateChange` channels back it, and the maximized
  and fullscreen states now persist across restarts.
- Added a right-click menu for text and links — cut, copy, paste, select all, and
  copy link address. Off macOS the app has no menu bar, so this is the only route
  to copy and paste.
- Added Open at login to the tray, registering OMP Studio to start hidden in the
  tray. Offered only where Electron can register a login item, so not on Linux and
  not from an unpackaged run.
- Added Open log folder to the tray menu, and made the Show/Hide entry a single
  item whose label follows whether a window is on screen.
- Added a "Desktop" section to the setup drawer that surfaces the shell's own
  runtime: the running sidecar's version, the active profile, the bundled sidecar
  binary, the state root, the OMP config root the sidecar runs under, the sidecar
  log path, and the state of the `omp-studio` command shim. It is drawn only
  inside the desktop shell; a browser-served client has no such section, so the
  same client stays a single build.
- Added a relocatable desktop state root. The user can move the desktop state
  (window geometry, the sidecar log, and the OMP config root the sidecar runs
  under) to any folder they choose. The pointer to the chosen root is kept in the
  platform-default userData directory, since it cannot live inside the root it
  points at. A first move copies only the desktop-owned state, and any state the
  destination already holds is never clobbered. If the saved root becomes
  unwritable, the launch falls back to the default for that start and offers a
  repair instead of failing; the fix is the same reset that returns to the
  default. Without an explicit move, the sidecar keeps the user's existing
  `~/.omp` config and sessions, driven by the new `OMP_CONFIG_ROOT` absolute
  override.
- Added a sidecar repair check. The Desktop section can verify the bundled OMP
  runtime is present and, off Windows, executable. The check is read-only: the
  app never mutates its own installed sidecar, and the remedy for a missing
  binary is a reinstall, which is what the result tells the user to do.
- Added a managed `omp-studio` command shim so the app's bundled runtime is
  callable as `omp-studio` (open the app) and `omp-studio cli ...` (run the
  bundled OMP CLI) without a global OMP install and without editing any PATH
  entry. The shim is written to a per-user directory that is already on the
  default PATH on Windows and Linux. A shim is owned by its first line — a
  marker — and a file without it is treated as the user's and never clobbered.
- Extended the release matrix from a single Windows target to five: win32-x64,
  darwin-arm64, darwin-x64, linux-x64, and linux-arm64. Each target downloads
  only its own platform-matched OMP binary and uploads only its own artifacts:
  the NSIS installer on Windows, dmg and zip on macOS, and AppImage and deb on
  Linux. Every leg runs the packaged sidecar with `--smoke-test` before
  uploading, and every artifact lands in `SHA256SUMS.txt`.
- Added macOS signing, notarization, and hardened-runtime entitlements. The
  `afterSign` hook submits the signed app to the notary service and staples the
  receipt when the Apple credential set is configured; without it the build
  stays unsigned-but-validated, the same bootstrap contract as Windows. A
  signed leg must pass `codesign --verify --strict` and `stapler verify` before
  it uploads.
- Added an `afterPack` check that fails the build when the packed tree is
  missing the sidecar, the tray icon, or the preload bundle, or when it carries
  a sidecar for a different architecture. A wrong-arch bundle is no longer
  possible by accident.
- Added an in-app version notice to the Desktop section: the running runtime
  version, a link to the release page, and the pointer to `SHA256SUMS.txt`.
  It informs; it never downloads or installs anything.

### Changed

- Changed sidecar shutdown to ask the sidecar to stop before forcing it, so its
  own OMP RPC teardown runs whenever the request is accepted. The request goes
  over a stdin control channel, which is the only graceful stop that works on
  Windows. A sidecar that does not announce the channel is signalled directly
  rather than waited on.
- Changed the saved window size to the restored size rather than the current one.
  Quitting from a maximized window used to persist the display-filling bounds, so
  unmaximizing after a restart had nothing smaller to return to.
- Changed notifications to open the app when clicked. They were fire-and-forget, so
  a toast about a finished run led nowhere; clicking one now shows and focuses the
  window, restoring it first if it was minimized.
- Changed OMP Studio to register its Windows application identity, so notifications
  are attributed to OMP Studio instead of to the Electron executable.
- Changed notification content to be bounded and stripped of control characters
  rather than only type-checked. The OS draws it outside any window the shell
  controls.

### Removed

- Removed the unused `electron-updater` dependency. OMP Studio Desktop has no
  update feed and users update by installing a new release.
- Removed the application menu off macOS, where a frameless window that draws its
  own title bar has no use for a menu bar. macOS keeps its menu, which is where
  that platform's Cmd+C, Cmd+V, and Cmd+Q live.
- Removed the desktop Content-Security-Policy override. It replaced the server's
  header with a copy widened by `'unsafe-inline'` styles, `blob:` images, and
  cross-port `http://127.0.0.1:*`, and dropped `base-uri` and `frame-ancestors`
  with it. The client needs none of that, so the desktop now runs under the same
  policy as the browser surface.

### Fixed

- Fixed Desktop startup and shutdown hangs when the Studio sidecar fails to become ready or does not exit promptly.
- Fixed packaged Desktop builds serving a stale Studio client after a sidecar restart.
- Fixed sidecar termination reaching only the root process. The force pass now
  terminates the whole tree, so an `omp --mode rpc-ui` child the sidecar started
  for a Studio session cannot outlive the app. On POSIX that child was reliably
  orphaned; on Windows the old behaviour happened to survive because the sidecar
  runtime places its children in a job object, which is not a guarantee the shell
  should depend on.

### Security

- Desktop IPC channels now reject calls from any renderer other than the OMP
  Studio window.
- OMP Studio now denies every OS permission request. Electron allows most of them
  by default, so a document inside the shell could previously reach the microphone,
  geolocation, or the clipboard read API without the shell deciding. Nothing is
  granted yet; a permission will be added only by the feature that needs it.
