import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	installCommandShims,
	planShimWrite,
	renderShim,
	resolveShimBinDir,
	SHIM_MARKER,
	shimFileName,
} from "../src/main/command-shim";

const APP = `C:\\apps\\omp-studio\\OMP Studio.exe`;
const SIDECAR = `C:\\apps\\omp-studio\\resources\\omp-server\\omp.exe`;

describe("command-shim", () => {
	it("names the shim per platform", () => {
		expect(shimFileName("win32")).toBe("omp-studio.cmd");
		expect(shimFileName("darwin")).toBe("omp-studio");
		expect(shimFileName("linux")).toBe("omp-studio");
	});

	it("renders a Windows shim with the marker, quoted paths, and a cli passthrough", () => {
		const shim = renderShim("win32", { appExecPath: APP, sidecarPath: SIDECAR });
		const firstLine = shim.split("\r\n")[0];
		expect(firstLine).toContain(SHIM_MARKER);
		expect(shim).toContain(`"${APP}"`);
		// The cli branch rebuilds the argument list after dropping the `cli`
		// selector (a bare %* would still carry it, as %* ignores shift), then
		// calls the sidecar and exits with its code.
		expect(shim).toContain(`call "${SIDECAR}" %OMP_STUDIO_CLI_ARGS%`);
		expect(shim).toContain('if /i "%~1"=="cli"');
		expect(shim).toContain(":cli-args");
		expect(shim).toContain(":cli-run");
		expect(shim).toContain("exit /b %ERRORLEVEL%");
		// %1, not %~1: the user's own quoting must survive to the sidecar.
		expect(shim).toContain('set "OMP_STUDIO_CLI_ARGS=%OMP_STUDIO_CLI_ARGS% %1"');
		// The terminator must use the set/defined pair, not `if "%~1"==""`:
		// the expanded form cannot tell an empty argument from end-of-args and
		// would drop it plus everything after, while a quoted value would
		// unbalance a direct %1 comparison.
		expect(shim).toContain('set "T=%1"');
		expect(shim).toContain("if not defined T goto :cli-run");
		expect(shim).not.toContain('if "%~1"=="" goto :cli-run');
	});

	it("renders a POSIX shim with the marker, quoted paths, and a cli passthrough", () => {
		const shim = renderShim("linux", { appExecPath: "/opt/app", sidecarPath: "/opt/app/omp" });
		const firstLines = shim.split("\n");
		expect(firstLines[0]).toBe("#!/bin/sh");
		expect(firstLines[1]).toContain(SHIM_MARKER);
		expect(shim).toContain('exec "/opt/app"');
		expect(shim).toContain('exec "/opt/app/omp" "$@"');
	});

	it("plans the shim write: create / conflict / unchanged / update", () => {
		const desired = renderShim("linux", { appExecPath: "/app", sidecarPath: "/app/omp" });
		expect(planShimWrite(undefined, desired)).toBe("create");
		expect(planShimWrite("#!/bin/sh\necho user owned", desired)).toBe("conflict");
		expect(planShimWrite(desired, desired)).toBe("unchanged");
		expect(planShimWrite(`#!/bin/sh\n# ${SHIM_MARKER} v0\nold body`, desired)).toBe("update");
	});

	it("treats a file that mentions the marker only below its header as the user's", () => {
		const desired = renderShim("linux", { appExecPath: "/app", sidecarPath: "/app/omp" });
		const userFile = `#!/bin/sh\necho hi\n# adapted from an ${SHIM_MARKER} example\n`;
		expect(planShimWrite(userFile, desired)).toBe("conflict");
		// Same on Windows, where the marker would live on line 1.
		const winUser = `@echo off\necho hi\n@REM from an ${SHIM_MARKER} example\n`;
		const winDesired = renderShim("win32", { appExecPath: "C:\\app", sidecarPath: "C:\\app\\omp" });
		expect(planShimWrite(winUser, winDesired)).toBe("conflict");
	});

	it("resolves the shim dir per platform", () => {
		const win = resolveShimBinDir("win32", { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" });
		expect(win).toEqual([
			{ dir: path.join("C:\\Users\\u\\AppData\\Local", "Microsoft", "WindowsApps"), onDefaultPath: true },
			{ dir: path.join("C:\\Users\\u\\AppData\\Local", "omp-studio", "bin"), onDefaultPath: false },
		]);

		const linux = resolveShimBinDir("linux", {});
		expect(linux).toHaveLength(1);
		expect(linux[0].onDefaultPath).toBe(true);
		expect(linux[0].dir.endsWith(path.join(".local", "bin"))).toBe(true);

		const darwin = resolveShimBinDir("darwin", {});
		expect(darwin).toHaveLength(1);
		expect(darwin[0].onDefaultPath).toBe(false);
	});

	describe("installCommandShims", () => {
		let root = "";
		const env = () => ({ LOCALAPPDATA: root });
		const options = () => ({ platform: "win32", env: env(), appExecPath: APP, sidecarPath: SIDECAR });

		beforeEach(async () => {
			root = path.join(os.tmpdir(), `command-shim-${Math.floor(Math.random() * 1e9)}`);
			await fs.mkdir(root, { recursive: true });
		});

		afterEach(async () => {
			await fs.rm(root, { recursive: true, force: true });
		});

		it("creates, then reuses, then conflicts on a marker-less file", async () => {
			const first = await installCommandShims(options());
			expect(first.installed).toBe(true);
			expect(first.onDefaultPath).toBe(true);
			const file = path.join(first.dir, shimFileName("win32"));
			expect((await fs.readFile(file, "utf8")).split("\r\n")[0]).toContain(SHIM_MARKER);

			const second = await installCommandShims(options());
			expect(second).toEqual(first);

			await fs.writeFile(file, "my own command", "utf8");
			const third = await installCommandShims(options());
			expect(third.installed).toBe(false);
			expect(third.conflict).toBe(true);
			// The user's file is never clobbered.
			expect(await fs.readFile(file, "utf8")).toBe("my own command");
		});
	});
});
