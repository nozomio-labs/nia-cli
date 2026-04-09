/**
 * Bootstrap a writable just-bash session for a vault.
 *
 * Unlike nia-shell-docs (which uses an in-memory file map), this builds a
 * RemoteVaultFs implementation that proxies every read/write to the backend.
 * The agent gets the full bash builtin set including `>`, `>>`, `cp`, `tee`,
 * `find -delete`, here-docs, etc., and every mutation persists immediately.
 */

import { Bash } from "just-bash";
import { RemoteVaultFs } from "./remote-vault-fs.ts";
import type { VaultApiClient, VaultLoadResponse } from "./vault-api-client.ts";

const VAULT_EXECUTION_LIMITS = {
	maxCommandCount: 5_000,
	maxLoopIterations: 5_000,
	maxCallDepth: 100,
	maxSubstitutionDepth: 20,
	maxSourceDepth: 10,
	maxFileDescriptors: 100,
	maxAwkIterations: 5_000,
	maxSedIterations: 5_000,
	maxJqIterations: 5_000,
	maxGlobOperations: 50_000,
	maxArrayElements: 50_000,
	maxBraceExpansionResults: 5_000,
	maxOutputSize: 4 * 1024 * 1024,
	maxStringLength: 4 * 1024 * 1024,
	maxHeredocSize: 4 * 1024 * 1024,
};

function buildVaultEnv(
	vaultId: string,
	displayName: string,
): Record<string, string> {
	return {
		HOME: "/",
		VAULT_ID: vaultId,
		VAULT_NAME: displayName,
		BASH_ALIAS_ll: "ls -alF",
		BASH_ALIAS_la: "ls -a",
		BASH_ALIAS_l: "ls -CF",
		BASH_ALIAS_schema: "cat /schema.md",
		BASH_ALIAS_idx: "cat /index.md",
		BASH_ALIAS_tree2: "tree -L 2",
	};
}

export interface CreateVaultBashOptions {
	vaultId: string;
	displayName: string;
	client: VaultApiClient;
	initial: VaultLoadResponse;
}

export async function createVaultBash(opts: CreateVaultBashOptions): Promise<{
	bash: Bash;
	fs: RemoteVaultFs;
}> {
	const fs = new RemoteVaultFs(opts.client, opts.initial);
	const bash = new Bash({
		fs,
		cwd: "/",
		env: buildVaultEnv(opts.vaultId, opts.displayName),
		executionLimits: VAULT_EXECUTION_LIMITS,
	});
	await bash.exec("shopt -s expand_aliases");
	return { bash, fs };
}
