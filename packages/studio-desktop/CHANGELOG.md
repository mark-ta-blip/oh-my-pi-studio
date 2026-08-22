# Changelog

## [Unreleased]

### Added

- Added the initial Electron desktop shell for OMP Studio with a supervised OMP sidecar, secure preload bridge, tray controls, window state persistence, and platform build targets.
- Added deterministic app and tray assets, Windows NSIS packaging validation,
  and a packaged sidecar smoke test that verifies local token exchange and
  authenticated bootstrap before shutdown.
- Added `--hidden` to start OMP Studio in the tray without showing a window, and
  `--quit` to stop an already-running instance.

### Changed

- Changed sidecar shutdown to ask the sidecar to stop before forcing it, so its
  own OMP RPC teardown runs whenever the request is accepted.

### Removed

- Removed the unused `electron-updater` dependency. OMP Studio Desktop has no
  update feed and users update by installing a new release.

### Fixed

- Fixed Desktop startup and shutdown hangs when the Studio sidecar fails to become ready or does not exit promptly.
- Fixed packaged Desktop builds serving a stale Studio client after a sidecar restart.
- Fixed orphaned OMP processes after quitting on Windows. Terminating the sidecar
  now terminates its whole process tree, so the `omp --mode rpc-ui` children it
  started for each Studio session no longer outlive the app.

### Security

- Desktop IPC channels now reject calls from any renderer other than the OMP
  Studio window.
