import * as fs from "node:fs/promises";
import * as path from "node:path";

export type SidecarRepairReason = "missing" | "not-executable";

export interface SidecarRepairResult {
	ok: boolean;
	path: string;
	reason?: SidecarRepairReason;
}

/**
 * Verify the bundled sidecar binary is present (and, off Windows, executable).
 *
 * Purely a read: this is a repair *check*, and the release policy forbids the
 * app from mutating its own installed sidecar. The failure remedy is a
 * reinstall, which is what the channel's message tells the user to do.
 */
export async function verifySidecarBinary(serverResourceDir: string, platform: string): Promise<SidecarRepairResult> {
	const sidecarPath = path.join(serverResourceDir, platform === "win32" ? "omp.exe" : "omp");
	try {
		await fs.access(sidecarPath);
	} catch {
		return { ok: false, path: sidecarPath, reason: "missing" };
	}
	if (platform !== "win32") {
		try {
			await fs.access(sidecarPath, fs.constants.X_OK);
		} catch {
			return { ok: false, path: sidecarPath, reason: "not-executable" };
		}
	}
	return { ok: true, path: sidecarPath };
}
