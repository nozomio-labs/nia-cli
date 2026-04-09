/**
 * `nia vault open <id>` — drops the user (or agent) into an interactive
 * just-bash session with the vault mounted as a writable filesystem.
 *
 * Both interactive and one-shot (`-c "command"`) modes are supported, mirroring
 * `npx nia-docs <url> -c "command"`. The agent skill plugin in cli.ts ships
 * instructions to agents to use the one-shot form for surgical reads/writes
 * inside their tool loops, and the interactive form for exploratory sessions.
 */

import { OpenAPI } from "nia-ai-ts";
import { app } from "../app.ts";
import { resolveBaseUrl } from "../services/config.ts";
import { createSdk } from "../services/sdk.ts";
import { withErrorHandling } from "../utils/errors.ts";
import { createVaultBash } from "./create-vault-bash.ts";
import { VaultApiClient, type VaultLoadResponse } from "./vault-api-client.ts";
import { VaultSession } from "./vault-session.ts";

export const openCommand = app
	.sub("open")
	.meta({
		description:
			"Drop into an interactive bash session with the vault mounted as a writable filesystem",
	})
	.args([
		{ name: "id", type: "string", description: "Vault ID", required: true },
	] as const)
	.flags({
		c: {
			type: "string",
			description: "Execute a single command and exit (non-interactive)",
		},
		"paths-only": {
			type: "boolean",
			description:
				"Bootstrap with file paths only (cat fetches content lazily). Auto-enabled for vaults > 1000 files.",
		},
	})
	.run(async ({ args, flags }) => {
		await withErrorHandling({ domain: "Vault" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });
			const baseUrl = await resolveBaseUrl();
			const apiKey = OpenAPI.TOKEN as string;

			const client = new VaultApiClient(baseUrl, apiKey, args.id);
			const initial: VaultLoadResponse = await client.load(
				flags["paths-only"] === true,
			);

			const vaultMeta = initial.vault as Record<string, unknown>;
			const displayName = (vaultMeta?.display_name as string) ?? "vault";

			const { bash } = await createVaultBash({
				vaultId: args.id,
				displayName,
				client,
				initial,
			});

			const session = new VaultSession(bash, {
				vaultId: args.id,
				displayName,
				banner: flags.c
					? undefined
					: `\nNia Vault — ${displayName}\nVault ID: ${args.id}\n${initial.file_count} file(s) loaded${initial.paths_only ? " (paths only — cat fetches lazily)" : ""}\nType \`exit\` or Ctrl-D to leave.\n\n`,
			});

			if (flags.c) {
				const exitCode = await session.execOnce(flags.c as string);
				// Drain stdout/stderr before exiting. Without this, when output
				// is piped (non-TTY), the buffer can be killed by process.exit
				// before it flushes, swallowing the command output entirely.
				await new Promise<void>((resolve) => {
					const drainStdout = () => process.stdout.write("", () => resolve());
					if (process.stderr.writableLength > 0) {
						process.stderr.write("", drainStdout);
					} else {
						drainStdout();
					}
				});
				process.exitCode = exitCode;
				return;
			}

			await session.start();
		});
	});
