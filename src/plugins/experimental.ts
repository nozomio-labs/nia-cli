import type { CommandNode, CrustPlugin, FlagDef } from "@crustjs/core";
import { persistExperimentalPreference } from "../services/config.ts";

const experimentalFlagDef: FlagDef = {
	type: "boolean",
	description: "Persist and use the experimental load-balanced API",
	inherit: true,
};

function injectExperimentalFlag(
	command: CommandNode,
	addFlag: (command: CommandNode, name: string, def: FlagDef) => void,
): void {
	addFlag(command, "experimental", experimentalFlagDef);

	for (const subCommand of Object.values(command.subCommands)) {
		injectExperimentalFlag(subCommand, addFlag);
	}
}

export function experimentalModePlugin(): CrustPlugin {
	return {
		name: "experimental-mode",
		setup(context, actions) {
			injectExperimentalFlag(context.rootCommand, actions.addFlag);
		},
		async middleware(context, next) {
			const experimental = context.input?.flags.experimental;
			if (typeof experimental === "boolean") {
				await persistExperimentalPreference(experimental);
			}

			await next();
		},
	};
}
