/**
 * Interactive bash session for a vault. Adapted from the nia-shell-docs
 * session loop, with two changes:
 *  - the cwd starts at "/" (vault root) instead of "/{domain}/docs"
 *  - we drop the cat-rewrite helper since vaults don't have the auto-extension
 *    expansion problem (paths are written exactly as they appear)
 *
 * The readline interface is constructed lazily inside `start()` so that the
 * one-shot `execOnce()` path (used by `nia vault open <id> --c "..."`) does
 * NOT register a stdin "close" handler. Without that gating, running in a
 * non-TTY context would close stdin immediately, fire the close handler, and
 * `process.exit(0)` would kill the process before the bash command finished.
 */

import { createInterface, type Interface } from "node:readline";
import type { Bash } from "just-bash";

const EXEC_TIMEOUT_MS = 30_000;

export interface VaultSessionOpts {
	vaultId: string;
	displayName: string;
	banner?: string;
}

export class VaultSession {
	private rl: Interface | null = null;
	private cwd = "/";
	private bash: Bash;
	private vaultId: string;
	private displayName: string;
	private banner?: string;

	constructor(bash: Bash, opts: VaultSessionOpts) {
		this.bash = bash;
		this.vaultId = opts.vaultId;
		this.displayName = opts.displayName;
		this.banner = opts.banner;
	}

	private formatPrompt(): string {
		return `vault:${this.displayName}${this.cwd === "/" ? "" : this.cwd}$ `;
	}

	async start(): Promise<void> {
		// Lazy: only create the readline interface when we actually need
		// interactive input. The one-shot execOnce() path never calls start().
		this.rl = createInterface({
			input: process.stdin,
			output: process.stdout,
			prompt: this.formatPrompt(),
			terminal: process.stdin.isTTY ?? false,
		});
		this.rl.on("close", () => process.exit(0));
		this.rl.on("SIGINT", () => {
			process.stdout.write("^C\n");
			this.rl?.prompt();
		});

		if (this.banner) {
			process.stdout.write(this.banner);
		}

		this.rl.prompt();

		for await (const line of this.rl) {
			const command = line.trim();
			if (!command) {
				this.rl.prompt();
				continue;
			}
			if (command === "exit" || command === "quit") {
				this.rl.close();
				return;
			}

			try {
				const result = await this.bash.exec(command, {
					cwd: this.cwd,
					signal: AbortSignal.timeout(EXEC_TIMEOUT_MS),
				});
				if (result.stdout) process.stdout.write(result.stdout);
				if (result.stderr) process.stderr.write(result.stderr);
				if (result.env?.PWD) this.cwd = result.env.PWD;
			} catch (err) {
				if (err instanceof Error && err.name === "TimeoutError") {
					process.stderr.write("Error: command timed out\n");
				} else {
					process.stderr.write(
						`Error: ${err instanceof Error ? err.message : String(err)}\n`,
					);
				}
			}

			this.rl.setPrompt(this.formatPrompt());
			this.rl.prompt();
		}
	}

	async execOnce(command: string): Promise<number> {
		try {
			const result = await this.bash.exec(command, {
				cwd: this.cwd,
				signal: AbortSignal.timeout(EXEC_TIMEOUT_MS),
			});
			if (result.stdout) process.stdout.write(result.stdout);
			if (result.stderr) process.stderr.write(result.stderr);
			return result.exitCode ?? 0;
		} catch (err) {
			process.stderr.write(
				`Error: ${err instanceof Error ? err.message : String(err)}\n`,
			);
			return 1;
		}
	}
}
