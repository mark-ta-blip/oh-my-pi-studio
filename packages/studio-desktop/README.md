# OMP Studio Desktop

The desktop shell starts the existing `omp studio` command as a local sidecar and loads its loopback URL in an isolated Electron window.

Development requires `bun` and `electron` on `PATH`:

```sh
bun run desktop:dev
```

Packaged builds require `OMP_STUDIO_OMP_EXECUTABLE` to point at an OMP executable matching the build target:

```sh
OMP_STUDIO_OMP_EXECUTABLE=../coding-agent/dist/omp bun run dist:win
```
