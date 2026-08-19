# Changelog

## [Unreleased]

### Added

- Added the initial Electron desktop shell for OMP Studio with a supervised OMP sidecar, secure preload bridge, tray controls, window state persistence, and platform build targets.
- Added deterministic app and tray assets, Windows NSIS packaging validation,
  and a packaged sidecar smoke test that verifies local token exchange and
  authenticated bootstrap before shutdown.

### Fixed

- Fixed Desktop startup and shutdown hangs when the Studio sidecar fails to become ready or does not exit promptly.
- Fixed packaged Desktop builds serving a stale Studio client after a sidecar restart.
