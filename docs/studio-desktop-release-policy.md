# OMP Studio Desktop Release Policy

OMP Studio Desktop is a Windows-first local application, packaged for five
platform targets: win32-x64, darwin-arm64, darwin-x64, linux-x64, and
linux-arm64. A release packages a platform-matched OMP binary as its sidecar
and never downloads or resolves a different executable at runtime.

## Release Contract

1. The release workflow builds a platform-matched `omp-<target>` binary from
   the tagged source for every target.
2. Each desktop job downloads its own platform-matched artifact, copies it
   into the Electron resources as the sidecar (`omp-server/omp.exe` on
   Windows, `omp-server/omp` elsewhere), and builds its installers: NSIS on
   Windows, dmg plus zip on macOS, AppImage plus deb on Linux.
3. Each job runs the packaged sidecar with `--smoke-test` (under `xvfb` where
   a display is required). The test starts the sidecar, completes the one-time
   local token-to-cookie exchange, reads the authenticated Studio bootstrap
   payload, stops the sidecar, and exits without creating a browser window.
   A job whose smoke test fails does not upload.
4. `afterPack` fails the build when the packed tree is missing the sidecar,
   the tray icon, or the preload bundle, or carries a foreign-arch sidecar.
5. The verified installers are uploaded to the GitHub release and included in
   `SHA256SUMS.txt` alongside the OMP CLI assets.

The GitHub release tag, installers, and checksum file are the authoritative
release set. Release owners must verify the checksum after download before
announcing a desktop artifact.

## Windows Signing

`release_desktop_windows` accepts the standard electron-builder secrets
`WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`. When the certificate is configured,
CI verifies the Authenticode status of both the unpacked executable and the NSIS
installer before uploading them.

The workflow intentionally remains able to bootstrap without those secrets. An
unsigned installer is a build-validation artifact, not a trusted stable-channel
delivery. Before a public stable desktop rollout, the release owner must
provision a timestamped Windows code-signing certificate, configure the two
secrets, and require the signature-validation step to run green.

Certificate private material belongs only in the configured secret store. Do
not place certificates, passwords, or signing commands in the repository,
release notes, or desktop configuration files.

## macOS Signing and Notarization

`release_desktop_macos` signs and notarizes when the five `APPLE_*` secrets are
configured (the same set `scripts/ci-macos-sign.sh` uses for the `omp` binary).
The Developer ID certificate is handed to electron-builder directly via
`CSC_LINK` (the base64 `.p12` the secret already holds) and `CSC_KEY_PASSWORD`,
so the shell, its embedded sidecar, and the dmg are signed in one pass with the
hardened runtime and the three entitlements the bundled Bun sidecar needs. The
`afterSign` hook then notarizes the `.app` with `notarytool submit --wait` and
staples the receipt with `stapler staple` when the API-key trio is present, and
skips cleanly when it is not.

As on Windows, the leg intentionally remains able to bootstrap without those
secrets: an unsigned-but-complete bundle, smoke-tested before upload. A signed
build must pass `codesign --verify --strict` and `stapler verify` before upload,
so a notarization failure fails the leg rather than shipping an unverified
receipt.

## Update Policy

OMP Studio Desktop has no automatic updates, and this is a permanent product
decision rather than a deferral. There is no update feed, no background download,
no silent install, no self-replacement of the application, and no automatic
sidecar replacement. `electron-updater` is removed from the desktop package;
reintroducing it requires reversing this section first.

Users update by downloading a signed installer from the GitHub release. The
application may show its current version and link to the releases page. It must
not download or install anything.

Release owners can withdraw a bad installer, publish a replacement release, and
document its checksum. The application must never mutate an installed sidecar in
place as a rollback mechanism.

## Platform Coverage

The release matrix covers five targets: win32-x64, darwin-arm64, darwin-x64,
linux-x64, and linux-arm64. Windows is the first target and the one with a
code-signing secret configured by default; the others are packaged and
smoke-tested in CI from Phase 12 of
[`studio-desktop-plan.md`](./studio-desktop-plan.md) onward.

Each matrix target downloads only its own platform-matched OMP binary and
uploads only its own artifact globs. A Windows job must never require a macOS
`.dmg`, and a Linux job must never require a Windows installer. Keep the
per-platform artifact lists explicit so the expectation fails loudly when a
target produces nothing.

macOS signing and notarization follow
[`macos-signing-notarization.md`](./macos-signing-notarization.md). When the
Apple credential set is absent, the macOS legs still build and upload:
unsigned-but-complete, the same bootstrap contract as the Windows path. A
signed build must pass both `codesign --verify --strict` and `stapler verify`
before upload, so a notarization failure fails the leg rather than shipping an
unverified receipt.
