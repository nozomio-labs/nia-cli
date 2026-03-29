import { Crust } from "@crustjs/core";
import { renderHelp } from "@crustjs/plugins";
import pkg from "../package.json";
import { APP_NAME } from "./services/config.ts";

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
	})
	.run(({ command, flags }) => {
		const experimental = (flags as Record<string, unknown>).experimental;

		if (typeof experimental === "boolean") {
			console.log(
				experimental
					? "Experimental API enabled. Future commands will use the experimental API."
					: "Experimental API disabled. Future commands will use the standard API.",
			);
			return;
		}

		console.log(renderHelp(command));
	});
