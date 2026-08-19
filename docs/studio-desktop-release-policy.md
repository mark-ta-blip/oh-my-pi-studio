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

`electron-updater` is not enabled by the desktop runtime. There is no update
feed, background download, silent install, or automatic sidecar replacement.
Users update by downloading a signed installer from the GitHub release.

Automatic updates may be proposed only after all of the following exist:

1. A versioned HTTPS feed owned by the release team.
2. Signed Windows artifacts with publisher identity verification.
3. Checksum and signature verification before any download is offered.
4. A staged rollout policy with a documented pause and rollback path.
5. User-visible update state and an explicit install decision.

Until then, release owners can withdraw a bad installer, publish a replacement
release, and document its checksum. The application must not mutate an installed
sidecar in place as a rollback mechanism.
