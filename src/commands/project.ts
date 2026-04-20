/**
 * `nia project` — manage the per-project `nia.json` binding manifest.
 *
 * The manifest pins indexed Nia sources (repos / docs / vaults / local
 * folders) to the current project so every `nia search` invocation in this
 * directory tree auto-scopes to those sources. This is the fix for the
 * "agent runs `nia sources list | head -X` and misses the right source"
 * failure mode at scale (100+ globally-indexed sources).
 *
 * Subcommands:
 *
 *   nia project init   — interactive picker over your sources/repos/vaults,
 *                        writes nia.json, runs `nia local add .` (so the
 *                        project's own files are searchable too), and
 *                        appends a Nia block to CLAUDE.md / AGENTS.md.
 *   nia project link   — append a source to nia.json by id / name / URL.
 *   nia project unlink — remove a source from nia.json.
 *   nia project status — show bound sources with per-source health.
 *   nia project sync   — re-resolve identifiers to fresh ids, warn on
 *                        missing, rewrite nia.json.
 *
 * The shape of this file mirrors `commands/categories.ts` for command
 * structure and `commands/vault.ts` (init flow) for the auto-wire-into-
 * CLAUDE.md pattern. Backend-side, it reuses `cliSdk.sources` and the
 * existing local-folder daemon endpoints in `services/local/api.ts` —
 * no new backend routes are required.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { confirm, multiselect } from "@crustjs/prompts";
import { annotate } from "@crustjs/skills";
import { app } from "../app.ts";
import { normalizeResolvedSourcesResponse } from "../services/compat/sources.ts";
import { addLocalSource, listLocalSources } from "../services/local/api.ts";
import { paginateAll } from "../services/pagination.ts";
import {
	addLocalBinding,
	addSource,
	addVault,
	createEmptyManifest,
	findProjectManifest,
	MANIFEST_FILENAME,
	readManifest,
	removeLocalBinding,
	removeSource,
	removeVault,
	writeManifest,
} from "../services/project.ts";
import { createCliSdk } from "../services/sdk.ts";
import { withErrorHandling } from "../utils/errors.ts";
import { createOutput } from "../utils/output.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_INSTRUCTIONS_CANDIDATES = [
	"CLAUDE.md",
	"AGENTS.md",
	"GEMINI.md",
	"CURSOR.md",
] as const;

function detectProjectInstructionsFile(
	cwd: string = process.cwd(),
): string | null {
	for (const candidate of PROJECT_INSTRUCTIONS_CANDIDATES) {
		const full = path.join(cwd, candidate);
		try {
			if (existsSync(full)) {
				return candidate;
			}
		} catch {
			// ignore
		}
	}
	return null;
}

/**
 * Markdown block appended to CLAUDE.md/AGENTS.md by `project init`. Mirrors
 * the shape of `generateVaultAgentsMd` in `commands/vault.ts` so agents
 * encounter a consistent style across both surfaces.
 */
function generateProjectAgentsMd(projectName?: string): string {
	const safe = projectName?.trim() || "this project";
	return `## Nia (project-scoped)

This project has \`nia.json\` — Nia commands auto-scope to its bound sources for **${safe}**. You don't need to discover sources via \`nia sources list\`; the binding is already there.

\`\`\`bash
# Search auto-scopes to the manifest's sources, vaults, and local folders.
# No --repos / --docs / --local-folders needed.
nia search query "..."

# Inspect what's bound and per-source health
nia project status

# Add or remove sources as the project evolves
nia project link <id|owner/repo|url>
nia project unlink <id|owner/repo|url>

# Re-resolve stale identifiers after a source is re-indexed
nia project sync
\`\`\`

If the user asks about a topic clearly outside the bound set, fall back to \`nia sources summary\` or \`nia sources list --all\` for full discovery — but only then.
`;
}

interface ResolveProjectIdentifierResult {
	identifier: string;
	id?: string;
	type?: string;
	displayName?: string | null;
	matches: Array<{
		id?: string;
		type?: string;
		displayName?: string | null;
		identifier?: string | null;
	}>;
}

/**
 * Resolve a user-supplied identifier (UUID / display name / URL / owner-repo)
 * to its canonical Nia source. Returns the single matching source, or surfaces
 * ambiguous matches so the caller can decide. Falls back to using the raw
 * identifier when the API can't resolve it (so `link vercel/next.js` works
 * even if the repo isn't indexed yet — it just gets stored verbatim and the
 * user can run `nia project sync` later).
 */
async function resolveProjectIdentifier(
	cliSdk: Awaited<ReturnType<typeof createCliSdk>>,
	identifier: string,
): Promise<ResolveProjectIdentifierResult> {
	const result = await cliSdk.sources.resolve(identifier);
	const normalized = normalizeResolvedSourcesResponse(result);

	const [single] = normalized.items;
	if (normalized.items.length === 1 && single) {
		return {
			identifier,
			id: single.id,
			type: single.type,
			displayName: single.display_name ?? single.displayName,
			matches: normalized.items,
		};
	}

	return {
		identifier,
		matches: normalized.items,
	};
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

const initCommand = annotate(
	app
		.sub("init")
		.meta({
			description:
				"Initialize a project-scoped nia.json: pick sources interactively, add the cwd as a local folder, wire CLAUDE.md/AGENTS.md.",
		})
		.flags({
			name: {
				type: "string",
				description:
					"Project name to record in nia.json (defaults to cwd basename).",
			},
			local: {
				type: "boolean",
				default: true,
				description:
					"Add the cwd as a local folder source (`nia local add .`) and bind it (default: true). Pass `--no-local` to skip.",
			},
			wire: {
				type: "boolean",
				default: true,
				description:
					"Append a Nia block to CLAUDE.md / AGENTS.md (auto-detected). Pass --no-wire to skip.",
			},
			"wire-into": {
				type: "string",
				description:
					"Path to the project instructions file to append the Nia block to. Defaults to whichever of CLAUDE.md/AGENTS.md/GEMINI.md/CURSOR.md exists in cwd; creates CLAUDE.md if none exists.",
			},
			yes: {
				type: "boolean",
				short: "y",
				default: false,
				description:
					"Non-interactive: skip the source picker and write an empty nia.json. Use `nia project link` afterwards.",
			},
			force: {
				type: "boolean",
				default: false,
				description:
					"Overwrite an existing nia.json in cwd. Without --force, init refuses to clobber.",
			},
		})
		.run(async ({ flags }) => {
			const fmt = createOutput({ color: flags.color });

			await withErrorHandling({ domain: "Project init" }, async () => {
				const cwd = process.cwd();
				const manifestPath = path.join(cwd, MANIFEST_FILENAME);
				if (existsSync(manifestPath) && !flags.force) {
					throw new Error(
						`${MANIFEST_FILENAME} already exists in ${cwd}. Re-run with --force to overwrite, or edit it directly with \`nia project link\` / \`nia project unlink\`.`,
					);
				}

				const projectName =
					(flags.name as string | undefined)?.trim() || path.basename(cwd);
				let manifest = createEmptyManifest(projectName);

				// Step 1: optional interactive source picker
				if (!flags.yes && process.stdin.isTTY) {
					const cliSdk = await createCliSdk({ apiKey: flags["api-key"] });
					const pickedSources = await pickSources(cliSdk);
					for (const id of pickedSources) {
						manifest = addSource(manifest, id);
					}
				}

				// Step 2: add cwd as local folder (default on)
				let localBindingNote: string | null = null;
				if (flags.local !== false) {
					try {
						const local = await addLocalSource(cwd, flags["api-key"]);
						manifest = addLocalBinding(manifest, {
							path: ".",
							id: local.local_folder_id,
						});
						localBindingNote = `Registered ${cwd} as local folder source ${local.local_folder_id}.`;
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						localBindingNote = `Skipped local-folder registration: ${message}. Re-run \`nia local add .\` later.`;
					}
				}

				// Step 3: write nia.json
				writeManifest(manifestPath, manifest);

				// Step 4: optional wire into instructions file
				let wiredFile: string | null = null;
				let wireSkipReason: string | null = null;
				if (flags.wire !== false) {
					const explicit = flags["wire-into"] as string | undefined;
					const target =
						explicit ?? detectProjectInstructionsFile(cwd) ?? "CLAUDE.md";
					try {
						const block = generateProjectAgentsMd(projectName);
						const fullTarget = path.isAbsolute(target)
							? target
							: path.join(cwd, target);
						const existing = existsSync(fullTarget)
							? readFileSync(fullTarget, "utf8")
							: "";
						const separator =
							existing && !existing.endsWith("\n\n") ? "\n\n" : "";
						writeFileSync(fullTarget, existing + separator + block, "utf8");
						wiredFile = target;
					} catch (err) {
						wireSkipReason = err instanceof Error ? err.message : String(err);
					}
				} else {
					wireSkipReason = "skipped via --no-wire";
				}

				fmt.output({
					manifest: manifestPath,
					name: projectName,
					sources: manifest.sources,
					vaults: manifest.vaults,
					local: manifest.local,
					local_binding_note: localBindingNote,
					wired_into: wiredFile,
					wire_skip_reason: wireSkipReason,
					next_steps: [
						'`nia search query "..."` will now auto-scope to this project.',
						"Add more sources with `nia project link <id|owner/repo|url>`.",
						"Inspect bindings with `nia project status`.",
					],
				});
			});
		}),
	[
		"Run inside a project directory to bind indexed sources to a `nia.json`. Future `nia search` invocations from this tree auto-scope.",
		"By default also runs `nia local add .` so the project's own files are searchable alongside its bound sources. Pass `--no-local` to skip.",
		"Writes (or appends to) CLAUDE.md / AGENTS.md so any agent working in this directory immediately sees the project bindings.",
	],
);

/**
 * Fetch every indexed source available to the current account, paginated.
 *
 * The Nia API enforces `limit <= 100` per request, so we page via the shared
 * `paginateAll` helper up to a safety ceiling (500 items). This replaces an
 * earlier single-call `sources.list({ limit: 200 })` that started failing
 * with `query → limit: Input should be less than or equal to 100`.
 *
 * Exported so the pagination contract can be regression-tested directly
 * without spinning up the full `pickSources` interactive flow.
 */
export async function fetchAllSourcesForPicker(cliSdk: {
	sources: {
		list: (params?: { limit?: number; offset?: number }) => Promise<unknown>;
	};
}): Promise<Array<Record<string, unknown>>> {
	return paginateAll<Record<string, unknown>>(
		async ({ limit, offset }) =>
			(await cliSdk.sources.list({ limit, offset })) as
				| Array<Record<string, unknown>>
				| { items?: Array<Record<string, unknown>> }
				| null
				| undefined,
	);
}

/**
 * Build a multi-select picker from the user's existing sources.
 *
 * Implementation: pages through `cliSdk.sources.list` via
 * `fetchAllSourcesForPicker` (capped at 500 items). Users with more sources
 * than that can always `nia project link` more later. Local folders come
 * from `listLocalSources` so the picker matches what `nia sources summary`
 * would show.
 */
async function pickSources(
	cliSdk: Awaited<ReturnType<typeof createCliSdk>>,
): Promise<string[]> {
	const items = await fetchAllSourcesForPicker(cliSdk);

	if (items.length === 0) {
		const proceed = await confirm({
			message:
				"No indexed sources found yet. Continue with an empty nia.json? (You can `nia project link` later.)",
			default: true,
		});
		if (!proceed) {
			throw new Error("Aborted by user.");
		}
		return [];
	}

	const choices = items
		.map((item) => {
			const id = typeof item.id === "string" ? item.id : undefined;
			const displayName =
				(typeof item.display_name === "string"
					? item.display_name
					: undefined) ??
				(typeof item.displayName === "string" ? item.displayName : undefined);
			const identifier =
				typeof item.identifier === "string" ? item.identifier : undefined;
			const type = typeof item.type === "string" ? item.type : undefined;

			if (!id) return null;

			const label = displayName || identifier || id;
			const hintParts: string[] = [];
			if (type) hintParts.push(type);
			if (identifier && identifier !== label) hintParts.push(identifier);
			const hint = hintParts.length > 0 ? hintParts.join(" · ") : undefined;

			return {
				label,
				value: id,
				...(hint ? { hint } : {}),
			} as const;
		})
		.filter(
			(
				c,
			): c is {
				readonly label: string;
				readonly value: string;
				readonly hint?: string;
			} => c !== null,
		);

	if (choices.length === 0) {
		return [];
	}

	const picked = await multiselect<string>({
		message:
			"Pick sources to bind to this project (space to toggle, enter to confirm). Skip with no selection.",
		choices,
		maxVisible: 15,
	});

	return [...picked];
}

// ---------------------------------------------------------------------------
// link / unlink
// ---------------------------------------------------------------------------

const linkCommand = annotate(
	app
		.sub("link")
		.meta({
			description:
				"Bind a source (repo, doc, paper, dataset, or vault) to nia.json by id, name, or URL.",
		})
		.args([
			{
				name: "identifier",
				type: "string",
				description:
					"Source identifier — UUID, display name, owner/repo, or URL.",
				required: true,
			},
		] as const)
		.flags({
			vault: {
				type: "boolean",
				default: false,
				description:
					"Treat the identifier as a vault id and bind it under `vaults` instead of `sources`.",
			},
			"as-typed": {
				type: "boolean",
				default: false,
				description:
					"Skip the resolve step and store the identifier as-is. Useful for repos that aren't indexed yet.",
			},
		})
		.run(async ({ args, flags }) => {
			const fmt = createOutput({ color: flags.color });

			await withErrorHandling({ domain: "Project link" }, async () => {
				const manifestPath = ensureManifestPath();
				let manifest = readManifest(manifestPath);

				if (flags.vault) {
					manifest = addVault(manifest, args.identifier);
					writeManifest(manifestPath, manifest);
					fmt.output({
						manifest: manifestPath,
						added_vault: args.identifier,
						vaults: manifest.vaults,
					});
					return;
				}

				let stored = args.identifier;
				let resolution: ResolveProjectIdentifierResult | null = null;

				if (!flags["as-typed"]) {
					const cliSdk = await createCliSdk({ apiKey: flags["api-key"] });
					resolution = await resolveProjectIdentifier(cliSdk, args.identifier);
					if (resolution.id) {
						// Prefer the canonical id when we got an unambiguous hit
						stored = resolution.id;
					} else if (resolution.matches.length > 1) {
						fmt.warn(
							`Ambiguous identifier "${args.identifier}" — ${resolution.matches.length} matches. Stored as-typed; re-run with the exact id to disambiguate.`,
						);
					} else if (resolution.matches.length === 0) {
						fmt.warn(
							`Could not resolve "${args.identifier}" against your indexed sources. Storing as-typed; run \`nia project sync\` after indexing.`,
						);
					}
				}

				const before = manifest.sources.length;
				manifest = addSource(manifest, stored);
				if (manifest.sources.length === before) {
					fmt.info(`"${stored}" was already bound. No change.`);
				}
				writeManifest(manifestPath, manifest);

				fmt.output({
					manifest: manifestPath,
					added: stored,
					resolved: resolution
						? {
								id: resolution.id,
								type: resolution.type,
								display_name: resolution.displayName,
							}
						: undefined,
					sources: manifest.sources,
				});
			});
		}),
	[
		"Accepts UUIDs, owner/repo shorthand, URLs, or display names. The CLI resolves to the canonical id and stores that.",
		"Use `--as-typed` for repos you haven't indexed yet — they get stored verbatim and `nia project sync` resolves them later.",
		"Pass `--vault` to bind a vault id instead of a regular source.",
	],
);

const unlinkCommand = app
	.sub("unlink")
	.meta({
		description:
			"Remove a source binding from nia.json. Matches against the stored identifier or its canonical id.",
	})
	.args([
		{
			name: "identifier",
			type: "string",
			description:
				"Source identifier — UUID, name, or URL exactly as stored in nia.json.",
			required: true,
		},
	] as const)
	.flags({
		vault: {
			type: "boolean",
			default: false,
			description: "Remove from `vaults` instead of `sources`.",
		},
		local: {
			type: "boolean",
			default: false,
			description:
				"Remove from `local` (matches by path or id) instead of `sources`.",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });

		await withErrorHandling({ domain: "Project unlink" }, async () => {
			const manifestPath = ensureManifestPath();
			let manifest = readManifest(manifestPath);

			if (flags.vault) {
				manifest = removeVault(manifest, args.identifier);
			} else if (flags.local) {
				manifest = removeLocalBinding(manifest, args.identifier);
			} else {
				manifest = removeSource(manifest, args.identifier);
			}
			writeManifest(manifestPath, manifest);

			fmt.output({
				manifest: manifestPath,
				removed: args.identifier,
				sources: manifest.sources,
				vaults: manifest.vaults,
				local: manifest.local,
			});
		});
	});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

interface StatusRow {
	identifier: string;
	kind: "source" | "vault" | "local";
	id: string;
	name: string;
	type: string;
	status: string;
}

const statusCommand = app
	.sub("status")
	.meta({
		description:
			"Show bound sources from nia.json with per-source health (indexed / pending / orphaned / not-found).",
	})
	.run(async ({ flags }) => {
		const fmt = createOutput({ color: flags.color });

		await withErrorHandling({ domain: "Project status" }, async () => {
			const manifestPath = ensureManifestPath();
			const manifest = readManifest(manifestPath);
			const cliSdk = await createCliSdk({ apiKey: flags["api-key"] });

			const rows: StatusRow[] = [];

			for (const identifier of manifest.sources) {
				rows.push(await checkSourceStatus(cliSdk, identifier));
			}

			for (const vaultId of manifest.vaults) {
				rows.push({
					identifier: vaultId,
					kind: "vault",
					id: vaultId,
					name: "",
					type: "vault",
					status: "(use `nia vault info` for details)",
				});
			}

			let localSourcesById: Map<
				string,
				{ display_name?: string | null; path?: string | null }
			> | null = null;
			for (const binding of manifest.local) {
				const target = binding.id ?? binding.path;
				let status: string;
				let name = "";
				const id = binding.id ?? "";

				if (binding.id) {
					if (!localSourcesById) {
						try {
							const sources = await listLocalSources(flags["api-key"]);
							localSourcesById = new Map(
								sources.map((s) => [s.local_folder_id, s]),
							);
						} catch {
							localSourcesById = new Map();
						}
					}
					const match = localSourcesById.get(binding.id);
					if (match) {
						name = match.display_name ?? "";
						const onDiskPath = match.path ?? "";
						status =
							onDiskPath && pathExists(onDiskPath) ? "ready" : "path_not_found";
					} else {
						status = "orphaned";
					}
				} else {
					status = pathExists(
						path.resolve(path.dirname(manifestPath), binding.path),
					)
						? "needs_link"
						: "path_not_found";
				}

				rows.push({
					identifier: target,
					kind: "local",
					id,
					name,
					type: "local_folder",
					status,
				});
			}

			fmt.output(
				{
					manifest: manifestPath,
					name: manifest.name,
					counts: {
						sources: manifest.sources.length,
						vaults: manifest.vaults.length,
						local: manifest.local.length,
					},
					rows,
				},
				{ columns: ["identifier", "kind", "id", "name", "type", "status"] },
			);
		});
	});

async function checkSourceStatus(
	cliSdk: Awaited<ReturnType<typeof createCliSdk>>,
	identifier: string,
): Promise<StatusRow> {
	try {
		const result = await cliSdk.sources.resolve(identifier);
		const normalized = normalizeResolvedSourcesResponse(result);
		if (normalized.items.length === 0) {
			return {
				identifier,
				kind: "source",
				id: "",
				name: "",
				type: "",
				status: "not_found",
			};
		}
		if (normalized.items.length > 1) {
			return {
				identifier,
				kind: "source",
				id: "",
				name: "",
				type: "",
				status: `ambiguous (${normalized.items.length} matches)`,
			};
		}
		const [item] = normalized.items;
		if (!item) {
			return {
				identifier,
				kind: "source",
				id: "",
				name: "",
				type: "",
				status: "not_found",
			};
		}
		return {
			identifier,
			kind: "source",
			id: item.id ?? "",
			name: item.display_name ?? item.displayName ?? "",
			type: item.type ?? "",
			status: item.status ?? "indexed",
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			identifier,
			kind: "source",
			id: "",
			name: "",
			type: "",
			status: `error: ${message}`,
		};
	}
}

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

const syncCommand = annotate(
	app
		.sub("sync")
		.meta({
			description:
				"Re-resolve every identifier in nia.json against the API, replace name/URL identifiers with canonical ids, and warn on missing.",
		})
		.flags({
			"dry-run": {
				type: "boolean",
				default: false,
				description: "Print what would change without rewriting nia.json.",
			},
		})
		.run(async ({ flags }) => {
			const fmt = createOutput({ color: flags.color });

			await withErrorHandling({ domain: "Project sync" }, async () => {
				const manifestPath = ensureManifestPath();
				const manifest = readManifest(manifestPath);
				const cliSdk = await createCliSdk({ apiKey: flags["api-key"] });

				const updates: Array<{
					before: string;
					after: string;
					action: "kept" | "updated" | "missing" | "ambiguous";
					note?: string;
				}> = [];

				const newSources: string[] = [];
				for (const identifier of manifest.sources) {
					try {
						const resolved = await cliSdk.sources.resolve(identifier);
						const normalized = normalizeResolvedSourcesResponse(resolved);
						if (normalized.items.length === 0) {
							updates.push({
								before: identifier,
								after: identifier,
								action: "missing",
								note: "No match. Source may have been deleted or never indexed.",
							});
							newSources.push(identifier);
							continue;
						}
						if (normalized.items.length > 1) {
							updates.push({
								before: identifier,
								after: identifier,
								action: "ambiguous",
								note: `${normalized.items.length} matches; left as-typed.`,
							});
							newSources.push(identifier);
							continue;
						}
						const [item] = normalized.items;
						const canonical = item?.id ?? identifier;
						if (canonical !== identifier) {
							updates.push({
								before: identifier,
								after: canonical,
								action: "updated",
							});
						} else {
							updates.push({
								before: identifier,
								after: identifier,
								action: "kept",
							});
						}
						newSources.push(canonical);
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						updates.push({
							before: identifier,
							after: identifier,
							action: "missing",
							note: message,
						});
						newSources.push(identifier);
					}
				}

				const changed = updates.some((u) => u.action === "updated");

				if (!flags["dry-run"] && changed) {
					writeManifest(manifestPath, { ...manifest, sources: newSources });
				}

				fmt.output({
					manifest: manifestPath,
					dry_run: Boolean(flags["dry-run"]),
					changed,
					updates,
				});
			});
		}),
	[
		"Run after a source has been re-indexed under a new id, or whenever you want to canonicalize name/URL identifiers to UUIDs.",
		"Use `--dry-run` to preview what would change without rewriting nia.json.",
	],
);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function ensureManifestPath(): string {
	const found = findProjectManifest(process.cwd());
	if (!found) {
		throw new Error(
			`No ${MANIFEST_FILENAME} found in cwd or any parent directory. Run \`nia project init\` first.`,
		);
	}
	return found;
}

function pathExists(p: string): boolean {
	try {
		return existsSync(p) && statSync(p).isDirectory();
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Root command export
// ---------------------------------------------------------------------------

export const projectCommand = annotate(
	app
		.sub("project")
		.meta({
			description:
				"Per-project nia.json manifest: bind sources to this project so `nia search` auto-scopes.",
		})
		.command(initCommand)
		.command(linkCommand)
		.command(unlinkCommand)
		.command(statusCommand)
		.command(syncCommand),
	[
		"`nia.json` is the per-project source binding manifest. Once present, every `nia search query` / `universal` invocation in this directory tree auto-scopes to its sources.",
		'Use `nia project init` once per project. After that, `nia search query "..."` works without --repos / --docs flags — the manifest provides them.',
		"`nia project status` is the canonical way to see what's bound. Don't run `nia sources list` to discover what's in scope; the manifest already declared it.",
	],
);

// Re-export for tests / programmatic use
export type { ProjectManifest } from "../services/project.ts";
