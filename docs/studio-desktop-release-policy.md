# OMP Studio Desktop Release Policy

OMP Studio Desktop is a Windows-first local application. A release packages a
platform-matched OMP binary as its sidecar and never downloads or resolves a
different executable at runtime.

## Release Contract

1. The release workflow builds `omp-windows-x64.exe` from the tagged source.
2. The Windows desktop job downloads that exact artifact, copies it into the
   Electron resources as `omp-server/omp.exe`, and builds the NSIS installer.
3. The job runs `win-unpacked/OMP Studio.exe --smoke-test`. The test starts the
   packaged sidecar, completes the one-time local token-to-cookie exchange,
   reads the authenticated Studio bootstrap payload, stops the sidecar, and
   exits without creating a browser window.
4. The verified installer is uploaded to the GitHub release and included in
   `SHA256SUMS.txt` with the OMP CLI assets.

The GitHub release tag, installer, and checksum file are the authoritative
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

Windows is the first and currently the only packaged target. Phase 12 of
[`studio-desktop-plan.md`](./studio-desktop-plan.md) extends the release matrix
to darwin-arm64, darwin-x64, linux-x64, and linux-arm64.

Each matrix target downloads only its own platform-matched OMP binary and
uploads only its own artifact globs. A Windows job must never require a macOS
`.dmg`, and a Linux job must never require a Windows installer. Keep the
per-platform artifact lists explicit so the expectation fails loudly when a
target produces nothing.

macOS signing and notarization follow
[`macos-signing-notarization.md`](./macos-signing-notarization.md).
