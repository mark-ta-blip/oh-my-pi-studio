import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";

const MAX_WORKSPACE_LABEL_LENGTH = 120;

export class WorkspaceRegistrationError extends Error {}

export interface WorkspaceRegistration {
	canonicalPath: string;
	label: string;
}

function resolveLabel(label: string | undefined, canonicalPath: string): string {
	if (label !== undefined && typeof label !== "string") {
		throw new WorkspaceRegistrationError("Workspace label must be a string.");
	}
	const fallback = path.basename(canonicalPath) || "Workspace";
	const resolved = (label ?? fallback).trim();
	if (!resolved) throw new WorkspaceRegistrationError("Workspace label cannot be empty.");
	if (resolved.length > MAX_WORKSPACE_LABEL_LENGTH) {
		throw new WorkspaceRegistrationError(
			`Workspace label must be ${MAX_WORKSPACE_LABEL_LENGTH} characters or fewer.`,
		);
	}
	return resolved;
}

/** Resolve one user-selected directory to an internal canonical workspace path. */
export async function resolveWorkspaceRegistration(inputPath: string, label?: string): Promise<WorkspaceRegistration> {
	const trimmedPath = inputPath.trim();
	if (!trimmedPath) throw new WorkspaceRegistrationError("Workspace path cannot be empty.");

	let canonicalPath: string;
	try {
		canonicalPath = await fs.realpath(path.resolve(trimmedPath));
	} catch (error) {
		if (isEnoent(error)) throw new WorkspaceRegistrationError("Workspace directory does not exist.");
		throw new WorkspaceRegistrationError("Studio could not resolve the workspace directory.");
	}

	try {
		if (!(await fs.stat(canonicalPath)).isDirectory()) {
			throw new WorkspaceRegistrationError("Workspace path must identify a directory.");
		}
	} catch (error) {
		if (error instanceof WorkspaceRegistrationError) throw error;
		throw new WorkspaceRegistrationError("Studio could not inspect the workspace directory.");
	}

	return { canonicalPath, label: resolveLabel(label, canonicalPath) };
}
