import { annotate } from "@crustjs/skills";
import { OpenAPI } from "nia-ai-ts";
import { app } from "../app.ts";
import { resolveBaseUrl } from "../services/config.ts";
import { createSdk } from "../services/sdk.ts";
import { createResponseError, withErrorHandling } from "../utils/errors.ts";
import { createOutput } from "../utils/output.ts";

/**
 * Nia Vault — agent-maintained personal wikis on top of Nia sources.
 *
 * A vault is a writable, private filesystem that an LLM agent maintains by
 * distilling indexed Nia sources (repos, docs, papers, Notion, Drive, etc.)
 * into a markdown wiki. The vault is mounted via the same /v2/fs/{id}/*
 * endpoints as any other source, so the existing `nia sources read/grep/tree/
 * ls/find/write/mv/mkdir/rm` commands work against it by passing the vault id.
 *
 * The commands in this file cover the vault-specific verbs only:
 *   create / list / get / delete / rename
 *   add-source / remove-source / list-sources
 *   ingest / sync / lint / cancel
 *   search
 *   setup / skill (CLAUDE.md / SKILL.md generation for agent installation)
 *   open (interactive bash session via just-bash; see ../shell/)
 *
 * The SDK does not yet have typed VaultsService bindings; until the next
 * `nia-ai-ts` publish we hit /v2/vaults/* via raw fetch (same pattern that
 * `nia sources write` uses for /v2/fs/* endpoints in sources.ts).
 */

type VaultMode = "ingest" | "sync" | "lint" | "refresh";

async function vaultFetch(
	method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT",
	pathSuffix: string,
	apiKey: string | undefined,
	body?: Record<string, unknown>,
	query?: Record<string, string | number | undefined>,
): Promise<Record<string, unknown>> {
	await createSdk({ apiKey });
	const baseUrl = await resolveBaseUrl();
	const token = OpenAPI.TOKEN;

	const url = new URL(`${baseUrl}/vaults${pathSuffix}`);
	if (query) {
		for (const [k, v] of Object.entries(query)) {
			if (v !== undefined && v !== null) {
				url.searchParams.set(k, String(v));
			}
		}
	}

	const init: RequestInit = {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
	};
	if (body !== undefined) {
		init.body = JSON.stringify(body);
	}

	const response = await fetch(url.toString(), init);
	if (!response.ok) {
		throw await createResponseError(
			response,
			`Vault ${method} ${pathSuffix} failed`,
		);
	}
	return (await response.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

const createCommand = app
	.sub("create")
	.meta({
		description:
			"Create a new vault (agent-maintained personal wiki on top of Nia sources)",
	})
	.args([
		{
			name: "display-name",
			type: "string",
			description: "Human-readable name for the vault",
			required: true,
		},
	] as const)
	.flags({
		description: {
			type: "string",
			description: "Optional description",
		},
		"from-source": {
			type: "string",
			description:
				"Comma-separated list of indexed source IDs to seed the vault with",
		},
		"schema-file": {
			type: "string",
			description:
				"Path to a custom schema.md (defaults to the standard template)",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });
		await withErrorHandling({ domain: "Vault" }, async () => {
			let schemaMd: string | undefined;
			if (flags["schema-file"]) {
				const fs = await import("node:fs");
				schemaMd = fs.readFileSync(flags["schema-file"] as string, "utf8");
			}

			const sourceIds = (flags["from-source"] as string | undefined)
				?.split(",")
				.map((s) => s.trim())
				.filter(Boolean);

			const result = await vaultFetch("POST", "", flags["api-key"], {
				display_name: args["display-name"],
				description: flags.description,
				source_ids: sourceIds,
				schema_md: schemaMd,
			});
			fmt.output(result);
		});
	});

const listCommand = app
	.sub("list")
	.meta({ description: "List your vaults" })
	.flags({
		limit: { type: "number", description: "Maximum results (default 100)" },
		offset: { type: "number", description: "Pagination offset" },
	})
	.run(async ({ flags }) => {
		const fmt = createOutput({ color: flags.color });
		await withErrorHandling({ domain: "Vault" }, async () => {
			const result = await vaultFetch("GET", "", flags["api-key"], undefined, {
				limit: flags.limit,
				offset: flags.offset,
			});
			fmt.output(result);
		});
	});

const getCommand = app
	.sub("get")
	.meta({ description: "Get vault metadata and workflow status" })
	.args([
		{ name: "id", type: "string", description: "Vault ID", required: true },
	] as const)
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });
		await withErrorHandling({ domain: "Vault" }, async () => {
			const result = await vaultFetch("GET", `/${args.id}`, flags["api-key"]);
			fmt.output(result);
		});
	});

const infoCommand = app
	.sub("info")
	.meta({
		description:
			"Alias for `get` — show vault metadata, file count, and workflow status",
	})
	.args([
		{ name: "id", type: "string", description: "Vault ID", required: true },
	] as const)
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });
		await withErrorHandling({ domain: "Vault" }, async () => {
			const result = await vaultFetch("GET", `/${args.id}`, flags["api-key"]);
			fmt.output(result);
		});
	});

const deleteCommand = app
	.sub("delete")
	.meta({
		description:
			"Delete a vault. Removes all wiki pages from Postgres AND drops the TurboPuffer namespace.",
	})
	.args([
		{ name: "id", type: "string", description: "Vault ID", required: true },
	] as const)
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });
		await withErrorHandling({ domain: "Vault" }, async () => {
			const result = await vaultFetch(
				"DELETE",
				`/${args.id}`,
				flags["api-key"],
			);
			fmt.output(result);
		});
	});

const renameCommand = app
	.sub("rename")
	.meta({ description: "Rename a vault" })
	.args([
		{ name: "id", type: "string", description: "Vault ID", required: true },
		{
			name: "new-name",
			type: "string",
			description: "New display name",
			required: true,
		},
	] as const)
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });
		await withErrorHandling({ domain: "Vault" }, async () => {
			const result = await vaultFetch(
				"PATCH",
				`/${args.id}`,
				flags["api-key"],
				{ display_name: args["new-name"] },
			);
			fmt.output(result);
		});
	});

const updateSchemaCommand = app
	.sub("update-schema")
	.meta({
		description:
			"Replace the vault's schema.md (the wiki conventions the agent reads on every run)",
	})
	.args([
		{ name: "id", type: "string", description: "Vault ID", required: true },
		{
			name: "file",
			type: "string",
			description: "Path to the new schema.md file",
			required: true,
		},
	] as const)
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });
		await withErrorHandling({ domain: "Vault" }, async () => {
			const fs = await import("node:fs");
			const schemaMd = fs.readFileSync(args.file, "utf8");
			const result = await vaultFetch(
				"PATCH",
				`/${args.id}`,
				flags["api-key"],
				{
					schema_md: schemaMd,
				},
			);
			fmt.output(result);
		});
	});

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const addSourceCommand = app
	.sub("add-source")
	.meta({ description: "Add an indexed Nia source to a vault" })
	.args([
		{ name: "id", type: "string", description: "Vault ID", required: true },
		{
			name: "source-id",
			type: "string",
			description: "Indexed source ID to add",
			required: true,
		},
	] as const)
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });
		await withErrorHandling({ domain: "Vault" }, async () => {
			const result = await vaultFetch(
				"POST",
				`/${args.id}/sources`,
				flags["api-key"],
				{ source_id: args["source-id"] },
			);
			fmt.output(result);
		});
	});

const removeSourceCommand = app
	.sub("remove-source")
	.meta({ description: "Remove a source from a vault" })
	.args([
		{ name: "id", type: "string", description: "Vault ID", required: true },
		{
			name: "source-id",
			type: "string",
			description: "Indexed source ID to remove",
			required: true,
		},
	] as const)
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });
		await withErrorHandling({ domain: "Vault" }, async () => {
			const result = await vaultFetch(
				"DELETE",
				`/${args.id}/sources/${args["source-id"]}`,
				flags["api-key"],
			);
			fmt.output(result);
		});
	});

const listSourcesCommand = app
	.sub("list-sources")
	.meta({ description: "List the sources currently linked to a vault" })
	.args([
		{ name: "id", type: "string", description: "Vault ID", required: true },
	] as const)
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });
		await withErrorHandling({ domain: "Vault" }, async () => {
			const result = await vaultFetch(
				"GET",
				`/${args.id}/sources`,
				flags["api-key"],
			);
			fmt.output(result);
		});
	});

// ---------------------------------------------------------------------------
// Workflow trigger / cancel
// ---------------------------------------------------------------------------

function makeRunCommand(mode: VaultMode, description: string) {
	return app
		.sub(mode)
		.meta({ description })
		.args([
			{ name: "id", type: "string", description: "Vault ID", required: true },
		] as const)
		.flags({
			source: {
				type: "string",
				description:
					"Comma-separated source IDs to limit the run to (default: all sources in the vault)",
			},
			model: {
				type: "string",
				description:
					"LLM model override (e.g. claude-opus-4-6, claude-sonnet-4-5-20250929)",
			},
			force: {
				type: "boolean",
				description:
					"For ingest/refresh: re-synthesize pages even for sources that already have pages (default: false — sources with existing pages are skipped)",
			},
		})
		.run(async ({ args, flags }) => {
			const fmt = createOutput({ color: flags.color });
			await withErrorHandling({ domain: "Vault" }, async () => {
				const sourceIds = (flags.source as string | undefined)
					?.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
				const result = await vaultFetch(
					"POST",
					`/${args.id}/run`,
					flags["api-key"],
					{
						mode,
						source_ids: sourceIds,
						model: flags.model,
						force: flags.force === true,
					},
				);
				fmt.output(result);
			});
		});
}

const ingestCommand = makeRunCommand(
	"ingest",
	"For each source in the vault that has no wiki page yet, ask Claude to read the source and produce concept/entity pages. Idempotent — pass --force to re-synthesize sources that already have pages.",
);
const syncCommand = makeRunCommand(
	"sync",
	"Regenerate wiki pages whose underlying sources have been re-indexed (skips human-edited pages)",
);
const refreshCommand = makeRunCommand(
	"refresh",
	"Combined ingest + sync in one locked pass — picks up new sources AND regenerates stale pages. This is the same mode the daily auto-sync cron uses.",
);
const lintCommand = makeRunCommand(
	"lint",
	"Walk the vault, find orphan pages and stale pages, write a fresh lint-report.md",
);

const autoSyncCommand = app
	.sub("auto-sync")
	.meta({
		description:
			"Toggle the daily auto-refresh cron for a vault. The server-side `vault_polling_workflow` runs at 09:00 UTC and triggers `mode=refresh` for every vault where this flag is True.",
	})
	.args([
		{ name: "id", type: "string", description: "Vault ID", required: true },
		{
			name: "state",
			type: "string",
			description: "`on` or `off`",
			required: true,
		},
	] as const)
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });
		await withErrorHandling({ domain: "Vault" }, async () => {
			const state = String(args.state).toLowerCase();
			if (state !== "on" && state !== "off") {
				throw new Error("state must be `on` or `off`");
			}
			const result = await vaultFetch(
				"PATCH",
				`/${args.id}`,
				flags["api-key"],
				{ auto_sync_enabled: state === "on" },
			);
			fmt.output(result);
		});
	});

const cancelCommand = app
	.sub("cancel")
	.meta({ description: "Cancel an in-flight vault workflow run" })
	.args([
		{ name: "id", type: "string", description: "Vault ID", required: true },
	] as const)
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });
		await withErrorHandling({ domain: "Vault" }, async () => {
			const result = await vaultFetch(
				"POST",
				`/${args.id}/cancel`,
				flags["api-key"],
				{},
			);
			fmt.output(result);
		});
	});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const searchCommand = app
	.sub("search")
	.meta({
		description:
			"Hybrid search scoped to one vault (semantic via TurboPuffer + grep fallback)",
	})
	.args([
		{ name: "id", type: "string", description: "Vault ID", required: true },
		{
			name: "query",
			type: "string",
			description: "Search query",
			required: true,
		},
	] as const)
	.flags({
		"top-k": {
			type: "number",
			description: "Maximum number of results (default 20)",
		},
		alpha: {
			type: "number",
			description:
				"Hybrid search blend (1.0 = pure semantic, 0.0 = pure keyword, default 0.7)",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });
		await withErrorHandling({ domain: "Vault" }, async () => {
			const result = await vaultFetch(
				"POST",
				`/${args.id}/search`,
				flags["api-key"],
				{
					query: args.query,
					top_k: flags["top-k"],
					alpha: flags.alpha,
				},
			);
			fmt.output(result);
		});
	});

// ---------------------------------------------------------------------------
// Templates: setup / agents / skill (CLAUDE.md / SKILL.md / guided onboarding)
//
// Three outputs, mirroring nia-shell-docs's templates.ts surface exactly:
//   - generateVaultBashExamples : reusable bash block (no header), used by both
//                                  the agents block and the skill body
//   - generateVaultAgentsMd     : `## <Name> Vault` block to APPEND to a project's
//                                  CLAUDE.md/AGENTS.md/GEMINI.md
//   - generateVaultSkillMd      : full SKILL.md with frontmatter + body
//   - generateVaultSetupMd      : guided onboarding prompt meant to be PIPED into
//                                  an agent (`nia vault setup <id> | claude`).
//                                  The agent reads it as a meta-prompt, asks the
//                                  user "file or skill or both?", then runs the
//                                  right install command.
// ---------------------------------------------------------------------------

function vaultSlug(displayName: string): string {
	const cleaned = (displayName || "nia")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned || "nia";
}

function generateVaultBashExamples(vaultId: string): string {
	return `\`\`\`bash
# Tree the vault
nia sources tree ${vaultId}

# Read a specific page
nia sources read ${vaultId} /index.md
nia sources read ${vaultId} /schema.md

# Find files via glob
nia sources find ${vaultId} "concepts/*.md"

# Grep across the wiki
nia sources grep ${vaultId} "pattern"

# Write a note (auto-protected from sync via provenance.last_human_edit)
nia sources write ${vaultId} /notes/finding.md --body "..."

# Search semantically (hybrid TurboPuffer + grep)
nia vault search ${vaultId} "conceptual question"

# Drop into an interactive bash session with the vault mounted as /
nia vault open ${vaultId}

# One-shot bash command (recommended for agent tool loops)
nia vault open ${vaultId} --c "tree && cat /index.md"
nia vault open ${vaultId} --c "echo '## Note' >> notes/today.md"

# Trigger the agent loop (background Hatchet workflows)
nia vault ingest ${vaultId}   # write new pages from sources without one
nia vault sync ${vaultId}     # regenerate stale pages, skip human edits
nia vault lint ${vaultId}     # find orphans + stale, write /lint-report.md
nia vault info ${vaultId}     # poll workflow status
\`\`\``;
}

function generateVaultAgentsMd(vaultId: string, displayName: string): string {
	const safe = displayName || "Nia";
	return `## ${safe} Vault

You have access to a private, agent-maintained Nia vault for **${safe}** (id: \`${vaultId}\`). It's a markdown wiki layered on top of indexed Nia sources, mounted as a writable filesystem in Postgres. Use it as your primary working memory for this project — read the wiki for context, write notes for findings, and use it to compound knowledge across sessions.

${generateVaultBashExamples(vaultId)}

**Wiki layout** (every vault has these): \`/schema.md\` (user-owned conventions, never overwritten), \`/index.md\` (auto-maintained catalog), \`/log.md\` (append-only history), \`/META.md\` (snapshot), \`/concepts/*.md\` and \`/entities/*.md\` (LLM-generated, regenerated by sync), \`/notes/*.md\` (user-curated, sync always respects), \`/lint-report.md\` (latest lint output).

**The "leave alone" rule**: any vault file you write via the bash session or \`nia sources write\` is automatically stamped with \`provenance.last_human_edit\` and skipped by \`vault sync\`. This protects both user edits and your own scratch notes from being clobbered.

**Schema**: read \`/schema.md\` inside the vault for the conventions the ingest workflow follows when generating new pages. You and the user can co-evolve it via \`nia vault update-schema ${vaultId} <local-schema.md>\`.
`;
}

function generateVaultSkillMd(vaultId: string, displayName: string): string {
	const safe = displayName || "Nia";
	const slug = vaultSlug(displayName);
	return `---
name: ${slug}-vault
description: Private agent-maintained Nia vault for ${safe} (id: ${vaultId}). Use when reading, writing, searching, or maintaining the wiki, or whenever the user references their ${safe} knowledge base.
---

# ${safe} Vault

A private agent-maintained markdown wiki for **${safe}**. The vault id is \`${vaultId}\`. It's mounted as a writable filesystem in Postgres on top of indexed Nia sources, queryable both as files (tree/grep/cat) and via semantic search.

## How to use

${generateVaultBashExamples(vaultId)}

## Wiki layout

- \`/schema.md\` — user-owned wiki conventions. NEVER overwritten by sync.
- \`/index.md\` — auto-maintained catalog of every page.
- \`/log.md\` — append-only ingest/sync/lint history.
- \`/META.md\` — vault snapshot (id, sources, timestamps).
- \`/concepts/*.md\` — LLM-generated concept pages with \`[[backlinks]]\`.
- \`/entities/*.md\` — LLM-generated entity pages.
- \`/notes/*.md\` — user-curated freeform pages. Sync always respects these.
- \`/lint-report.md\` — latest output of \`nia vault lint\`.

## Critical rule: human edits are protected

When you write to a vault file from a bash session or via \`nia sources write\`, the backend automatically stamps \`provenance.last_human_edit\` on that file's PG row. The \`vault sync\` workflow MUST skip any page with \`last_human_edit\` set. This means edits you make are protected and will not be nuked by background sync.
`;
}

function generateVaultSetupMd(vaultId: string, displayName: string): string {
	const safe = displayName || "Nia";
	const slug = vaultSlug(displayName);
	return `# ${safe} Vault — Setup

You are helping a user wire a private Nia vault into this project. The vault is **${safe}** (id: \`${vaultId}\`). It's an agent-maintained markdown wiki on top of indexed Nia sources, mounted as a writable filesystem in Postgres, and queryable both as files (tree/grep/cat) and via semantic search.

1. First, briefly explain to the user what the vault is and why they'd want it wired in: "It's a private, persistent wiki on top of your indexed Nia sources. Wiring it into this project means I'll use it as my working memory in every session here — no need to re-explain context, no re-derived knowledge, edits compound."
2. Ask the user which option they prefer:

Options:

1. **Append to agent instructions file (recommended)** — Adds a lightweight \`## ${safe} Vault\` block to the project's agent config file. Most reliable since instructions are always loaded and the footprint is small.
2. **Install as a skill** — Creates a skill directory with a SKILL.md. Skills are loaded on-demand by some agents but not always reliable.
3. **Both** — Adds to agent instructions and installs the skill.

After the user chooses, follow the steps below. If you are unsure which agent or tool the user is using, ask them.

## Option 1: Agent instructions file

Run this command and append the output to the project's agent instructions file:

\`\`\`bash
nia vault agents ${vaultId} >> <instructions-file>
\`\`\`

Common instructions files by tool:

| Tool | File |
|------|------|
| Claude Code | \`CLAUDE.md\` |
| GitHub Copilot | \`AGENTS.md\` |
| Codex | \`AGENTS.md\` |
| Gemini CLI | \`GEMINI.md\` |
| Cursor | \`AGENTS.md\` |
| OpenCode | \`AGENTS.md\` |
| Other | \`AGENTS.md\` |

If the file doesn't exist yet, create it first: \`touch <instructions-file>\`.

## Option 2: Skill

Run this command and write the output to the skill directory:

| Tool | Skill path |
|------|-----------|
| Claude Code | \`.claude/skills/${slug}-vault/SKILL.md\` |
| Codex | \`.agents/skills/${slug}-vault/SKILL.md\` |
| Cursor | \`.cursor/skills/${slug}-vault/SKILL.md\` or \`.agents/skills/${slug}-vault/SKILL.md\` |
| OpenCode | \`.opencode/skills/${slug}-vault/SKILL.md\` or \`.agents/skills/${slug}-vault/SKILL.md\` |
| Gemini CLI | \`.gemini/skills/${slug}-vault/SKILL.md\` or \`.agents/skills/${slug}-vault/SKILL.md\` |
| GitHub Copilot | \`.github/skills/${slug}-vault/SKILL.md\` |
| Other | \`.agents/skills/${slug}-vault/SKILL.md\` |

\`\`\`bash
mkdir -p <skill-dir>/${slug}-vault
nia vault skill ${vaultId} > <skill-dir>/${slug}-vault/SKILL.md
\`\`\`

## Option 3: Both

Run both sets of commands above.

After setup, confirm to the user what was written and where, and remind them that the vault is now wired in for THIS project — future sessions of the agent in this directory will know about it automatically.
`;
}

const setupCommand = app
	.sub("setup")
	.meta({
		description:
			"Print a guided onboarding prompt that walks an agent through wiring this vault into the current project. Pipe into your agent: `nia vault setup <id> | claude`.",
	})
	.args([
		{ name: "id", type: "string", description: "Vault ID", required: true },
	] as const)
	.run(async ({ args, flags }) => {
		await withErrorHandling({ domain: "Vault" }, async () => {
			const meta = (await vaultFetch(
				"GET",
				`/${args.id}`,
				flags["api-key"],
			)) as {
				display_name?: string;
			};
			const displayName = meta.display_name ?? "Nia";
			process.stdout.write(generateVaultSetupMd(args.id, displayName));
		});
	});

const agentsCommand = app
	.sub("agents")
	.meta({
		description:
			"Print a `## <Name> Vault` block to append to a project's CLAUDE.md / AGENTS.md / GEMINI.md. Use: `nia vault agents <id> >> CLAUDE.md`.",
	})
	.args([
		{ name: "id", type: "string", description: "Vault ID", required: true },
	] as const)
	.run(async ({ args, flags }) => {
		await withErrorHandling({ domain: "Vault" }, async () => {
			const meta = (await vaultFetch(
				"GET",
				`/${args.id}`,
				flags["api-key"],
			)) as {
				display_name?: string;
			};
			const displayName = meta.display_name ?? "Nia";
			process.stdout.write(generateVaultAgentsMd(args.id, displayName));
		});
	});

const skillCommand = app
	.sub("skill")
	.meta({
		description:
			"Print a SKILL.md (Claude Code skill format) for the vault. Use: `nia vault skill <id> > .claude/skills/<name>-vault/SKILL.md`.",
	})
	.args([
		{ name: "id", type: "string", description: "Vault ID", required: true },
	] as const)
	.run(async ({ args, flags }) => {
		await withErrorHandling({ domain: "Vault" }, async () => {
			const meta = (await vaultFetch(
				"GET",
				`/${args.id}`,
				flags["api-key"],
			)) as {
				display_name?: string;
			};
			const displayName = meta.display_name ?? "Nia";
			process.stdout.write(generateVaultSkillMd(args.id, displayName));
		});
	});

// ---------------------------------------------------------------------------
// One-shot init: create + ingest + wire-into-project
//
// This is the recommended path for autonomous agent setup. It collapses what
// would otherwise be 4 separate commands (create, ingest, get-id, setup-append)
// into one atomic operation. Designed so an agent can fulfill "set me up with a
// vault for X" in a single shell call.
//
// Auto-detects the project's instructions file (CLAUDE.md > AGENTS.md > GEMINI.md
// > CURSOR.md) in the current working directory. Pass `--wire-into <path>` to
// override or `--no-wire` to skip. Triggers ingest unless `--no-ingest` is set.
// ---------------------------------------------------------------------------

const PROJECT_INSTRUCTIONS_CANDIDATES = [
	"CLAUDE.md",
	"AGENTS.md",
	"GEMINI.md",
	"CURSOR.md",
] as const;

async function detectProjectInstructionsFile(): Promise<string | null> {
	const fs = await import("node:fs");
	for (const candidate of PROJECT_INSTRUCTIONS_CANDIDATES) {
		try {
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		} catch {
			// ignore
		}
	}
	return null;
}

const initCommand = app
	.sub("init")
	.meta({
		description:
			"One-shot vault setup: create + ingest + wire-into-project. The recommended path for autonomous agent setup — collapses 4 commands into one atomic op.",
	})
	.args([
		{
			name: "name",
			type: "string",
			description:
				"Vault display name (e.g. 'AI Research', 'My Codebase Notes')",
			required: true,
		},
	] as const)
	.flags({
		"from-source": {
			type: "string",
			description:
				"Comma-separated indexed source IDs to seed the vault with. Get IDs from `nia sources summary` or `nia sources list`.",
		},
		description: {
			type: "string",
			description: "Optional vault description",
		},
		"wire-into": {
			type: "string",
			description:
				"Path to the project instructions file to append vault setup to (e.g. CLAUDE.md, AGENTS.md). Auto-detects in cwd if omitted; creates CLAUDE.md if no file is found.",
		},
		wire: {
			type: "boolean",
			default: true,
			description:
				"Wire the vault into a project instructions file (default: true). Pass `--no-wire` to skip when running outside a project context.",
		},
		ingest: {
			type: "boolean",
			default: true,
			description:
				"Trigger the ingest workflow after vault creation (default: true). Pass `--no-ingest` to skip when you want to add more sources before the first ingest.",
		},
		"schema-file": {
			type: "string",
			description:
				"Path to a custom schema.md (defaults to the standard Karpathy-style template)",
		},
		model: {
			type: "string",
			description:
				"LLM model for the ingest workflow. Defaults to claude-sonnet-4-5-1m (1M-token context). Other 1M variant: claude-opus-4-6-1m. Standard variants: claude-sonnet-4-5-20250929, claude-opus-4-6.",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });
		await withErrorHandling({ domain: "Vault" }, async () => {
			const sourceIds = (flags["from-source"] as string | undefined)
				?.split(",")
				.map((s) => s.trim())
				.filter(Boolean);

			let schemaMd: string | undefined;
			if (flags["schema-file"]) {
				const fs = await import("node:fs");
				schemaMd = fs.readFileSync(flags["schema-file"] as string, "utf8");
			}

			// Step 1: create the vault
			const createResult = (await vaultFetch("POST", "", flags["api-key"], {
				display_name: args.name,
				description: flags.description,
				source_ids: sourceIds,
				schema_md: schemaMd,
			})) as {
				id?: string;
				display_name?: string;
				namespace?: string;
				source_ids?: string[];
			};

			const vaultId = createResult.id;
			if (!vaultId) {
				throw new Error("Vault creation succeeded but returned no id");
			}

			// Step 2: trigger ingest (unless --no-ingest or no sources to ingest)
			let ingestStatus: "triggered" | "skipped" | "no-sources" = "skipped";
			let ingestRunId: string | null = null;
			if (flags.ingest !== false) {
				if (sourceIds && sourceIds.length > 0) {
					try {
						const runBody: Record<string, unknown> = { mode: "ingest" };
						if (flags.model) {
							runBody.model = flags.model;
						}
						const runResult = (await vaultFetch(
							"POST",
							`/${vaultId}/run`,
							flags["api-key"],
							runBody,
						)) as { workflow_run_id?: string };
						ingestRunId = runResult.workflow_run_id ?? null;
						ingestStatus = "triggered";
					} catch (err) {
						fmt.error(
							`Vault created but ingest failed to start: ${err instanceof Error ? err.message : String(err)}. You can retry with \`nia vault ingest ${vaultId}\`.`,
						);
					}
				} else {
					ingestStatus = "no-sources";
				}
			}

			// Step 3: wire the vault into the project's instructions file
			let wiredFile: string | null = null;
			let wireSkipReason: string | null = null;
			if (flags.wire !== false) {
				const explicit = flags["wire-into"] as string | undefined;
				let target: string | null = null;
				if (explicit) {
					target = explicit;
				} else {
					target = await detectProjectInstructionsFile();
					if (!target) {
						// Default to CLAUDE.md if no existing file is detected.
						target = "CLAUDE.md";
					}
				}

				try {
					const meta = (await vaultFetch(
						"GET",
						`/${vaultId}`,
						flags["api-key"],
					)) as { display_name?: string };
					const block = generateVaultAgentsMd(
						vaultId,
						meta.display_name ?? args.name,
					);
					const fs = await import("node:fs");
					const existing = fs.existsSync(target)
						? fs.readFileSync(target, "utf8")
						: "";
					const separator =
						existing && !existing.endsWith("\n\n") ? "\n\n" : "";
					fs.writeFileSync(target, existing + separator + block);
					wiredFile = target;
				} catch (err) {
					wireSkipReason = err instanceof Error ? err.message : String(err);
				}
			} else {
				wireSkipReason = "skipped via --no-wire";
			}

			// Step 4: print the structured summary
			fmt.output({
				vault_id: vaultId,
				display_name: createResult.display_name ?? args.name,
				namespace: createResult.namespace,
				source_ids: createResult.source_ids ?? [],
				ingest: {
					status: ingestStatus,
					workflow_run_id: ingestRunId,
				},
				wired_into: wiredFile,
				wire_skip_reason: wireSkipReason,
				next_steps: [
					ingestStatus === "triggered"
						? `Poll ingest status: nia vault info ${vaultId}`
						: ingestStatus === "no-sources"
							? `Add sources first, then run: nia vault ingest ${vaultId}`
							: `Trigger ingest manually when ready: nia vault ingest ${vaultId}`,
					`Browse the vault: nia vault open ${vaultId}`,
					`Search the vault: nia vault search ${vaultId} "<query>"`,
					wiredFile
						? `Future sessions in this directory will know about the vault automatically (${wiredFile} updated).`
						: "Vault was NOT wired into a project file. Run `nia vault setup <id> >> CLAUDE.md` later to wire it in.",
				],
			});
		});
	});

// ---------------------------------------------------------------------------
// Open (interactive bash session) — defined in ../shell/open-command.ts
// ---------------------------------------------------------------------------

import { openCommand } from "../shell/open-command.ts";

// ---------------------------------------------------------------------------
// Root command
// ---------------------------------------------------------------------------

export const vaultCommand = annotate(
	app
		.sub("vault")
		.meta({
			description:
				"Manage agent-maintained personal wikis (vaults) — Karpathy-style LLM knowledge bases backed by your indexed Nia sources",
		})
		.command(initCommand)
		.command(createCommand)
		.command(listCommand)
		.command(getCommand)
		.command(infoCommand)
		.command(deleteCommand)
		.command(renameCommand)
		.command(updateSchemaCommand)
		.command(addSourceCommand)
		.command(removeSourceCommand)
		.command(listSourcesCommand)
		.command(ingestCommand)
		.command(syncCommand)
		.command(refreshCommand)
		.command(lintCommand)
		.command(autoSyncCommand)
		.command(cancelCommand)
		.command(searchCommand)
		.command(setupCommand)
		.command(agentsCommand)
		.command(skillCommand)
		.command(openCommand),
	[
		"Vaults are agent-maintained markdown wikis backed by your indexed Nia sources (Karpathy 'LLM Knowledge Bases' pattern).",
		'AUTONOMOUS SETUP: `nia vault init "<topic>" --from-source <id1>,<id2>` is the one-shot recommended path — creates the vault, triggers ingest, and wires it into the project\'s CLAUDE.md / AGENTS.md / GEMINI.md automatically.',
		"Filesystem ops on vault contents use the existing `nia sources tree/ls/read/grep/write/mv/mkdir/rm` commands — pass the vault id as the source id.",
		'Drop into a writable bash session with `nia vault open <id>` (uses just-bash with a write-through filesystem). Use `nia vault open <id> --c "..."` for one-shot agent tool calls.',
		"`nia vault setup <id> | claude` pipes a guided onboarding prompt into an agent so it can wire the vault into the current project (asks user file vs skill vs both). `nia vault agents <id> >> CLAUDE.md` is the direct file-append form.",
	],
);
