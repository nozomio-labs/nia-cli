import { type CommandNode, Crust } from "@crustjs/core";
import { renderHelp } from "@crustjs/plugins";
import pkg from "../package.json";
import { APP_NAME, persistExperimentalPreference } from "./services/config.ts";

export async function runRootCommand({
	command,
	flags,
}: {
	command: CommandNode;
	flags: Record<string, unknown>;
}): Promise<void> {
	const experimental = flags.experimental;

	if (typeof experimental === "boolean") {
		await persistExperimentalPreference(experimental);
		console.log(
			experimental
				? "Experimental API enabled. Future commands will use the experimental API."
				: "Experimental API disabled. Future commands will use the standard API.",
		);
		return;
	}

	console.log(renderHelp(command));
}

/**
 * Root CLI builder with inheritable global flags.
 *
 * Exported separately from the entry point (`cli.ts`) so that command files
 * can call `root.sub("name")` to create sub-builders that inherit the global
 * flag types without introducing circular imports.
 */
export const app = new Crust(APP_NAME)
	.meta({
		description: pkg.description,
	})
	.flags({
		"api-key": {
			type: "string",
			description: "Nia API key (overrides env and config)",
			inherit: true,
		},
		verbose: {
			type: "boolean",
			description: "Enable verbose output",
			default: false,
			inherit: true,
		},
		color: {
			type: "boolean",
			description: "Colored output",
			default: true,
			inherit: true,
		},
		output: {
			type: "string",
			description: "Render results as json, table, or text (default)",
			inherit: true,
		},
		json: {
			type: "boolean",
			description: "Shorthand for --output json",
			default: false,
			inherit: true,
		},
	})
	.run(({ command, flags }) =>
		runRootCommand({
			command,
			flags: flags as Record<string, unknown>,
		}),
	);
