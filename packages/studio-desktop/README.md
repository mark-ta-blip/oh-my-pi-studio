# OMP Studio Desktop

The desktop shell starts the existing `omp studio` command as a local sidecar and loads its loopback URL in an isolated Electron window.

Development starts the source CLI sidecar and requires `bun` and `electron`:

```sh
bun run desktop:dev
```

Packaged builds require `OMP_STUDIO_OMP_EXECUTABLE` to point at an OMP executable matching the build target:

```sh
OMP_STUDIO_OMP_EXECUTABLE=../coding-agent/dist/omp bun run dist:win
```

On Windows PowerShell:

```powershell
$env:OMP_STUDIO_OMP_EXECUTABLE = "C:\path\to\omp-windows-x64.exe"
bun run dist:win
& ".\release\win-unpacked\OMP Studio.exe" --smoke-test
```

The packaged app always starts `resources/omp-server/omp.exe`; it does not use
the environment override. The smoke command opens no Electron window. It starts
the bundled sidecar, exchanges its one-time local token for a cookie, reads the
authenticated bootstrap endpoint, stops the sidecar, and exits.

See [the desktop release policy](../../docs/studio-desktop-release-policy.md)
for signing, checksum, and platform-coverage requirements, and
[the desktop plan](../../docs/studio-desktop-plan.md) for the active roadmap.
