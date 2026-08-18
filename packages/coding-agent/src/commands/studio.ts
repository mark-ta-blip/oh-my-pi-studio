import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { studioHelp as commandHelp } from "../cli/command-help";
import { runStudioCommand } from "../cli/studio-cli";

export default class Studio extends Command {
	static description = commandHelp.description;
	static flags = {
		port: Flags.integer({ char: "p", description: "Loopback port for the Studio server", default: 4317 }),
		"no-open": Flags.boolean({ description: "Do not open Studio in the default browser", default: false }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Studio);
		await runStudioCommand({
			port: flags.port,
			open: !flags["no-open"],
		});
	}
}
