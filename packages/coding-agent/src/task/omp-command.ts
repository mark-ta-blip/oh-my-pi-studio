import process from "node:process";

import { $env } from "@oh-my-pi/pi-utils";

interface OmpCommand {
	cmd: string;
	args: string[];
	shell: boolean;
}

const DEFAULT_CMD = process.platform === "win32" ? "omp.cmd" : "omp";
const DEFAULT_SHELL = process.platform === "win32";

export function resolveOmpCommand(): OmpCommand {
	const envCmd = $env.PI_SUBPROCESS_CMD;
	if (envCmd?.trim()) {
		return { cmd: envCmd, args: [], shell: DEFAULT_SHELL };
	}

	const entry = process.argv[1];
	if (entry && (entry.endsWith(".ts") || entry.endsWith(".js"))) {
		return { cmd: process.execPath, args: [entry], shell: false };
	}

	return { cmd: DEFAULT_CMD, args: [], shell: DEFAULT_SHELL };
}

function quoteWindowsCommandArgument(value: string): string {
	return `"${value.replaceAll("%", "%%").replaceAll('"', '""')}"`;
}

/**
 * Build an executable argv for an OMP child. On Windows, `.cmd` launchers and
 * `PI_SUBPROCESS_CMD` are dispatched through cmd.exe while generated arguments
 * remain individually quoted instead of becoming an interpolated shell string.
 */
export function resolveOmpCommandInvocation(args: readonly string[]): string[] {
	const command = resolveOmpCommand();
	if (!command.shell) return [command.cmd, ...command.args, ...args];
	const commandText = [command.cmd, ...command.args, ...args.map(quoteWindowsCommandArgument)].join(" ");
	return [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", commandText];
}
