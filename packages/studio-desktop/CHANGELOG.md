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
- Fixed sidecar termination reaching only the root process. The force pass now
  terminates the whole tree, so an `omp --mode rpc-ui` child the sidecar started
  for a Studio session cannot outlive the app. On POSIX that child was reliably
  orphaned; on Windows the old behaviour happened to survive because the sidecar
  runtime places its children in a job object, which is not a guarantee the shell
  should depend on.

### Security

- Desktop IPC channels now reject calls from any renderer other than the OMP
  Studio window.
