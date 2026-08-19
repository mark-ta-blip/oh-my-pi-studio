#!/usr/bin/env bun

import * as path from "node:path";
import { buildEmbeddedArchiveBase64 } from "@oh-my-pi/pi-utils/embedded-archive";
import { buildStudioClient } from "../src/build-client";

const GENERATED_FILE = path.join("src", "embedded-client.generated.txt");
const DIST_CLIENT_DIR = path.join("dist", "client");

const GENERATE_FLAG = "--generate";
const RESET_FLAG = "--reset";

// `--reset` restores the checked-in state: an empty file. Source checkouts build
// the client from src/client instead, so a populated bundle must never be
// committed — it would ship stale UI in every release built from that tree.
// Release paths generate it and reset afterwards; see the `finally` blocks in
// scripts/ci-release-build-binaries.ts, packages/coding-agent/scripts/build-binary.ts,
// and packages/coding-agent/scripts/bundle-dist.ts.

async function main(): Promise<void> {
	if (process.argv.includes(RESET_FLAG)) {
		await Bun.write(GENERATED_FILE, "");
		process.stdout.write(`Reset ${GENERATED_FILE}\n`);
		return;
	}

	if (!process.argv.includes(GENERATE_FLAG)) {
		process.stdout.write(`Skipping ${GENERATED_FILE}; pass ${GENERATE_FLAG} to build the embedded bundle\n`);
		return;
	}

	await buildStudioClient();
	const archiveBase64 = await buildEmbeddedArchiveBase64(DIST_CLIENT_DIR);
	await Bun.write(GENERATED_FILE, archiveBase64);
	process.stdout.write(`Generated ${GENERATED_FILE}\n`);
}

if (import.meta.main) await main();
