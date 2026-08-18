import { afterEach, describe, expect, it, vi } from "bun:test";
import * as studioCli from "../src/cli/studio-cli";
import Studio from "../src/commands/studio";

const TEST_CONFIG = { bin: "omp", version: "0.0.0-test", commands: new Map() };

afterEach(() => {
	vi.restoreAllMocks();
});

describe("studio command arguments", () => {
	it("passes the loopback port and browser preference to the Studio runner", async () => {
		const runStudioCommand = vi.spyOn(studioCli, "runStudioCommand").mockResolvedValue();
		const command = new Studio(["--port", "4321", "--no-open"], TEST_CONFIG);

		await command.run();

		expect(runStudioCommand).toHaveBeenCalledWith({ port: 4321, open: false });
	});
});
