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

### Changed

- Changed sidecar shutdown to ask the sidecar to stop before forcing it, so its
  own OMP RPC teardown runs whenever the request is accepted. The request goes
  over a stdin control channel, which is the only graceful stop that works on
  Windows. A sidecar that does not announce the channel is signalled directly
  rather than waited on.
- Changed the saved window size to the restored size rather than the current one.
  Quitting from a maximized window used to persist the display-filling bounds, so
  unmaximizing after a restart had nothing smaller to return to.

### Removed

- Removed the unused `electron-updater` dependency. OMP Studio Desktop has no
  update feed and users update by installing a new release.
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
