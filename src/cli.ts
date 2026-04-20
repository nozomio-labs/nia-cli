import {
	autoCompletePlugin,
	helpPlugin,
	type UpdateNotifierCacheAdapter,
	updateNotifierPlugin,
	versionPlugin,
} from "@crustjs/plugins";
import { skillPlugin } from "@crustjs/skills";
import { createStore, stateDir } from "@crustjs/store";
import pkg from "../package.json";
import { app } from "./app.ts";
import { authCommand } from "./commands/auth";
import { categoriesCommand } from "./commands/categories";
import { connectorsCommand } from "./commands/connectors";
import { contextsCommand } from "./commands/contexts";
import { datasetsCommand } from "./commands/datasets";
import { depsCommand } from "./commands/deps";
import { documentCommand } from "./commands/document";
import { extractCommand } from "./commands/extract";
import { gdriveCommand } from "./commands/gdrive";
import { githubCommand } from "./commands/github";
import { localCommand } from "./commands/local";
import { oracleCommand } from "./commands/oracle";
import { packagesCommand } from "./commands/packages";
import { papersCommand } from "./commands/papers";
import { personalCommand } from "./commands/personal";
import { projectCommand } from "./commands/project";
import { reposCommand } from "./commands/repos";
import { searchCommand } from "./commands/search";
import { slackCommand } from "./commands/slack";
import { sourcesCommand } from "./commands/sources";
import { tracerCommand } from "./commands/tracer";
import { usageCommand } from "./commands/usage";
import { vaultCommand } from "./commands/vault";
import { xCommand } from "./commands/x-integration";
import { experimentalModePlugin } from "./plugins/experimental.ts";
import { APP_NAME } from "./services/config.ts";

const updateStore = createStore({
	dirPath: stateDir(APP_NAME),
	name: "update-notifier",
	fields: {
		lastCheckedAt: { type: "number", default: 0 },
		latestVersion: { type: "string" },
		lastNotifiedVersion: { type: "string" },
	},
});

const cacheAdaptor: UpdateNotifierCacheAdapter = {
	read: async () => updateStore.read(),
	write: async (state) =>
		updateStore.write({
			lastCheckedAt: state.lastCheckedAt,
			lastNotifiedVersion: state.lastNotifiedVersion,
			latestVersion: state.latestVersion,
		}),
};

const main = app
	.command(authCommand)
	.command(searchCommand)
	.command(reposCommand)
	.command(sourcesCommand)
	.command(vaultCommand)
	.command(oracleCommand)
	.command(tracerCommand)
	.command(contextsCommand)
	.command(packagesCommand)
	.command(githubCommand)
	.command(localCommand)
	.command(personalCommand)
	.command(projectCommand)
	.command(papersCommand)
	.command(datasetsCommand)
	.command(categoriesCommand)
	.command(extractCommand)
	.command(documentCommand)
	.command(depsCommand)
	.command(connectorsCommand)
	.command(slackCommand)
	.command(gdriveCommand)
	.command(xCommand)
	.command(usageCommand)
	.use(experimentalModePlugin())
	.use(
		updateNotifierPlugin({
			packageName: pkg.name,
			currentVersion: pkg.version,
			cache: {
				adapter: cacheAdaptor,
			},
		}),
	)
	.use(versionPlugin(pkg.version))
	.use(helpPlugin())
	.use(autoCompletePlugin({ mode: "help" }))
	.use(
		skillPlugin({
			version: pkg.version,
			defaultScope: "global",
			instructions: `
### Step 0 — check for nia.json (HIGHEST PRIORITY, do this first)

**If the cwd or any parent directory contains a \`nia.json\` file, that is the canonical source list for this project.** Treat its \`sources\`, \`vaults\`, and \`local\` bindings as the working set for the entire conversation.

- **Do NOT run \`nia sources list\` or \`nia repos list\` to discover sources.** The manifest already declared them. At 100+ globally-indexed sources, listing-and-grepping misses the right one (especially when piped through \`head\` / \`tail\`).
- **Use \`nia search query "..."\` with no \`--repos\`/\`--docs\`/\`--local-folders\` flags.** The CLI auto-injects the bound source ids and prints a transparent stderr line like \`Using nia.json scope: 3 repos, 1 doc, 1 local folder\`. That's the confirmation that the scope was applied — you don't need to verify any other way.
- **To see what's bound, run \`nia project status\`** (NOT \`nia sources list\`). It prints per-source health (indexed / pending / orphaned / not_found).
- **Only fall back to discovery if the user explicitly asks about something outside the bound set.** Then use \`nia sources summary\` first (compact), and \`nia sources list --all\` / \`nia repos list --all\` if you genuinely need to enumerate every source.

**If no \`nia.json\` exists** and the user is starting work in a new project, suggest \`nia project init\`. It runs a two-step interactive flow: (1) asks \`Index the current project folder (<cwd>) as a local source?\` — defaults to **No**, opt-in only. (2) Presents a fuzzy picker over the user's indexed sources (repos, docs, papers, datasets, previously-registered local folders). Whatever the user selects in step 2 gets bound into \`nia.json\`; if they answered yes in step 1, the cwd is also registered with the local daemon (\`nia local add .\` equivalent) and added under \`local\`. Pass \`--yes\` to skip both prompts and write an empty manifest.

**\`nia project init\` does NOT mutate any file in the project root other than \`nia.json\`.** No CLAUDE.md, no AGENTS.md, no GEMINI.md. This skill is the canonical channel for \`nia.json\` guidance — any agent that has it installed already knows about Step 0. If you want to make sure the skill is installed for the user's agent, run \`nia skill\`.

After that, every \`nia search query\` from this directory tree auto-scopes — no \`--repos\` flags ever again.

To bypass the auto-scope for a single query (e.g. searching outside the project's bound set), pass \`--no-scope\`.

### Nia Workflow

**Use indexed Nia sources first. Web is the fallback, not the default.**

#### Rules

1. **Never use web fetch or run** \`nia search web\` **or** \`nia search deep\` **before checking whether the source already exists in Nia.**
2. If the user names a repo, doc site, paper, or dataset, treat it as a **known source** and stay inside Nia first.
3. Do not skip to web because it seems faster. Indexed Nia content is usually more complete and reliable.
4. **Never pipe \`nia sources list\` or \`nia repos list\` through \`head\` / \`tail\`** — at scale you will silently miss the right source. If you must enumerate, pass \`--all\` (paginates through every result) instead.

#### Required Workflow

1. **Check what exists already**
   - **First, look for \`nia.json\`** in cwd or parents (Step 0 above). If present, you already have the working set.
   - Otherwise, use \`nia sources summary\` for a compact inventory (counts + top-5 names per type), or \`nia sources resolve <identifier>\` to look up a specific name/URL.
   - Only run \`nia repos list --all\` / \`nia sources list --all\` when you truly need every source.
2. **If the source is already indexed, search inside Nia**
   - Use \`nia search query\` or \`nia search universal\` for answers. \`nia search query\` auto-scopes to \`nia.json\` when present.
   - Use \`nia repos tree\`, \`nia repos grep\`, \`nia repos read\`, \`nia sources tree\`, \`nia sources ls\`, \`nia sources grep\`, and \`nia sources read\` for direct inspection.
   - Use \`nia document agent <source-id> "question"\` to ask AI questions about indexed PDFs/documents with citations.
3. **If the source is not indexed but the identifier is known, index it first**
   - Repo: \`nia repos index <owner/repo>\`
   - Docs: \`nia sources index <root-doc-url>\`
   - Paper: \`nia papers index <arxiv-id-or-url>\`
   - Dataset: \`nia datasets index <dataset-id-or-url>\`
   - Subscribe to global source (instant if already indexed): \`nia sources subscribe <url>\`
   - Upload a PDF: \`nia sources upload <file.pdf>\`
4. **Wait for indexing, then continue in Nia**
   - Indexing usually takes 1-5 minutes.
   - Check progress with \`nia repos status\` or \`nia sources list\`.
5. **Use web search only as a last resort**
   - Only use \`nia search web\` or \`nia search deep\` when the source is truly unknown, cannot be indexed from the given information, or indexed search is clearly insufficient.

#### Extraction & Document Intelligence

- **Extract tables from PDFs**: \`nia extract table <source> --schema '...'\` — structured data extraction with JSON schema.
- **Detect elements in documents**: \`nia extract detect <source>\` — find symbols, annotations, and elements.
- **Engineering drawings**: \`nia extract engineering <source>\` — extract dimensions, tolerances, title blocks from technical drawings.
- **Query extractions**: \`nia extract query <extraction-id> "question"\` — ask follow-up questions about extracted data.
- **Document agent**: \`nia document agent <source-id> "question"\` — AI-powered Q&A with citations over any indexed document.

#### Dependency Management

- **Analyze a manifest**: \`nia deps analyze package.json\` — detect dependencies and find documentation URLs.
- **Auto-subscribe to docs**: \`nia deps subscribe package.json\` — automatically index documentation for all dependencies.

#### Integrations

- **Slack**: \`nia slack install-token --token xoxb-...\`, \`nia slack grep <id> "pattern"\`, \`nia slack messages <id>\`
- **Google Drive**: \`nia gdrive install\`, \`nia gdrive browse <id>\`, \`nia gdrive index <id>\`
- **X/Twitter**: \`nia x install <username> --token <bearer>\`
- **Connectors**: \`nia connectors list\`, \`nia connectors install <type>\`

#### Source Filesystem Operations

- **Write files**: \`nia sources write <id> <path> --body "content"\` or \`--file local.txt\`
- **Move/rename**: \`nia sources mv <id> <old-path> <new-path>\`
- **Create dirs**: \`nia sources mkdir <id> <path>\`
- **Delete files**: \`nia sources rm <id> <path>\`

#### Personal Data (macOS) — autonomous one-command setup

When the user wants to index personal data on macOS, USE \`nia personal\` instead of asking them to find SQLite paths manually. The CLI auto-discovers **35+ macOS personal-data sources across 4 tiers** and registers each with the right extractor:

- **Tier 1 (dedicated extractors)**: iMessage, Safari history, Chrome history, Firefox history, Telegram Desktop
- **Tier 2 (generic SQLite extraction — works today via the backend dispatcher's else-fallback to extract_generic())**: Apple Notes, WhatsApp, Apple Reminders, Apple Contacts, Apple Books library, Apple Books annotations, Apple Podcasts, Apple Photos metadata (faces/places/dates — NOT image bytes), Anki, Day One journal, Bear, Things 3, OmniFocus, **Screen Time / knowledgeC.db** (the killer "what did I do today" source — app launches, web visits across all browsers, focus modes, ~90 days of behavioral data), Significant Locations, Voice Memos metadata
- **Tier 3 (folder mode)**: Apple Mail (\`~/Library/Mail/V*\`), Apple Calendar (\`~/Library/Calendars\` with .ics files), Stickies, Obsidian vault (auto-discovered via .obsidian/), iCloud Drive, Documents, Downloads, Desktop
- **Tier 5 (developer brain dump)**: VSCode workspaceStorage, Cursor workspaceStorage, Claude Code session history (\`~/.claude/projects/\`)
- **Tier 6 (roadmap, surfaced in status only)**: Voice Memos audio (needs transcription), Screenshots (needs OCR), Discord/Signal/Slack desktop caches, shell history files

**Trigger phrases**: "index my life", "index my Mac", "set up personal data", "track my messages / notes / browser history", "remember everything I do", "build a vault from my personal data", "compound knowledge from my Mac", "ingest my screen time / app usage / browsing history", "track what I read / listen to / journal".

**The autonomous flow** — run these commands without asking permission:

\`\`\`
# 1. Probe what exists on disk + what's already registered (no writes)
nia personal status

# 2. Register the curated 'essential personal data' set (Tier 1 + a few Tier 2)
nia personal init --yes

# 3. Discover, register, AND create a vault in one shell call
nia personal init --yes --vault "My Life"

# 4. Maximum coverage — register every discoverable source (35+)
nia personal init --yes --all --vault "My Life"

# 5. Cherry-pick specific connectors (e.g. just Screen Time + Mail + Calendar)
nia personal init --yes --enable screen_time,mail,calendar
\`\`\`

**Default selection rules** (when no \`--enable\` or \`--all\` is given):
- Sources marked \`auto_enable=true\` in the catalog are registered. This is the curated essential set: iMessage, Safari, Chrome, Firefox, Notes, WhatsApp, Reminders, Contacts, Books, Books annotations, Calendar, Stickies, Obsidian.
- Sources marked \`auto_enable=false\` (high-volume firehoses, sensitive data, niche tools) require an explicit \`--enable\` or \`--all\`. This protects the user from accidentally indexing 90 days of every app launch.
- The user can always override with \`--enable connector1,connector2\` or \`--all\`.

\`nia personal init\` does all of the following:
1. Probes 35+ macOS personal-data paths via static candidates AND custom discovery callbacks (Firefox profiles, Anki collections, versioned Apple Books DBs, Photos.sqlite inside the photoslibrary package, Contacts AddressBook UUID-keyed sources, OmniFocus 3 vs 4, Obsidian vaults).
2. Cross-references with what's already registered in Nia by BOTH connector key and resolved path so re-runs are idempotent (folder-mode sources all share \`detected_type=folder\` and disambiguate by path).
3. Detects EACCES on protected paths and tells the user exactly how to grant Full Disk Access.
4. Registers each new source via the daemon endpoint with the right \`detected_type\` (the backend's \`db_extractor.py\` dispatches to a dedicated extractor if one exists, falling back to \`extract_generic()\` for any unknown type — so even sources without a dedicated extractor produce usable output).
5. (With \`--vault\`) Creates a vault seeded with all newly-registered sources AND any pre-existing personal sources, then triggers ingest with the 1M-context default model. \`--vault-model claude-opus-4-6-1m\` overrides the model.
6. Returns a structured JSON summary grouped by tier with source ids, vault id, ingest run id, blocked sources, "not found" probe details, and "needs new backend extractor" roadmap entries.

**Use \`--dry-run\`** to preview what would be registered without making any backend calls. **Use \`nia personal status\`** to inspect the full landscape grouped by tier — including sources that exist on disk but don't have a backend extractor yet (so the user/agent knows what's coming).

**Failure modes:**
- **Source exists but Full Disk Access not granted**: The CLI returns the source in \`blocked_on_permissions\` with the exact System Settings path. Tell the user to grant access to their terminal app, then re-run.
- **Source not found at standard path**: Returned in \`not_found\` with the paths searched. Some users have custom locations — they can register manually with \`nia local add <path>\`.
- **Source discovered but needs new backend extractor**: Returned in \`roadmap_no_extractor_yet\`. Tell the user it's known but not yet supported (Voice Memos audio needs transcription, Screenshots need OCR, Discord/Signal/Slack desktop caches need LevelDB extractors, etc.).
- **\`--vault\` requested but no sources found**: The vault step is skipped. Report what's missing and what permissions are needed.

#### Knowledge Base Vaults (agent-maintained personal wikis)

A **vault** is an agent-maintained markdown wiki layered on top of one or more indexed Nia sources. You read the raw sources, and the vault workflow distills them into structured \`concepts/*.md\` and \`entities/*.md\` pages with \`[[backlinks]]\` and source citations. The wiki **compounds across sessions** — sync respects your edits, ingest only writes pages that don't already exist, and lint catches drift. This is the "LLM Knowledge Bases" pattern (raw sources → LLM-maintained wiki → schema), implemented natively in Nia.

Vaults are **private to the user**, mounted as a writable filesystem in Postgres, and queryable both as files (tree/grep/cat) and via semantic search. For exact per-command syntax see \`commands/vault/*.md\`.

##### Autonomous setup: when the user says "set me up" / "index my X"

**TRIGGER PHRASES** (any of these and reasonable variations — be liberal):

- "set me up with a vault for X" / "create a vault for X" / "build a vault for X"
- "index my X" / "track my X" / "remember my X"
- "create a knowledge base on X" / "build me a wiki for X"
- "I'm doing research on X" / "I'm studying X" / "I'm learning X"
- "compound my knowledge of X across sessions"
- "I want you to remember the work we do on X"
- Anything where the user is asking for **persistent memory + multi-source synthesis**

**The one-prompt flow.** When you detect a trigger, execute these steps **autonomously without asking permission unless something is genuinely ambiguous**. The user wants you to do this for them, not walk them through it.

1. **Discover what's already indexed.** Run \`nia sources summary\` first — it gives you counts and names per source type (repositories, documentation, research_papers, huggingface_datasets, local_folders, slack, google_drive, x) in one shot. If you need ids, follow up with \`nia sources list --type <type>\` or \`nia repos list\`.

2. **Match the user's topic to existing sources.** Apply your own judgment. Be **liberal** — include any source that seems related. If the user said "transformers", include attention papers, language model repos, ML framework docs, anything plausibly relevant. Show the matches to the user briefly so they can veto, but proceed unless they object.

3. **If no existing sources match, OFFER TO INDEX NEW ONES.** Don't just say "I can't help, you have nothing indexed." Suggest concrete sources to index based on the topic:
   - Repos: \`nia repos index <owner/repo>\` (e.g. \`nia repos index huggingface/transformers\`)
   - Papers: \`nia papers index <arxiv-id-or-url>\`
   - Docs: \`nia sources index <root-doc-url>\` — index the **root URL**, not a single page
   - Subscribe to a globally pre-indexed source (instant, no wait): \`nia sources subscribe <url>\`
   - Wait for indexing to finish (poll with \`nia sources list\` or \`nia repos status\`)

4. **Use the one-shot \`nia vault init\` command — it collapses create + ingest + wire-into-project into one atomic op.** This is the recommended path:

\`\`\`
nia vault init "<inferred topic name>" \\
  --from-source <id1>,<id2>,<id3> \\
  --description "<one-line description>"
\`\`\`

   \`init\` will:
   1. Create the vault with the seed sources
   2. Trigger the ingest workflow in the background. **Default model is \`claude-sonnet-4-5-1m\` (1M-token context window via the \`anthropic-beta: context-1m-2025-08-07\` header).** This is what makes the vault wiki rich — the LLM reads up to ~600K chars / ~500 files of source content per source, not a sample. Override with \`--model claude-opus-4-6-1m\` for higher quality at higher cost, or \`--model claude-sonnet-4-5-20250929\` for the smaller-context cheaper variant.
   3. Auto-detect the project's instructions file (\`CLAUDE.md\` > \`AGENTS.md\` > \`GEMINI.md\` > \`CURSOR.md\` in cwd) and append the vault block to it (creates \`CLAUDE.md\` if none exists). Future sessions of any agent in this directory will automatically know about the vault.
   4. Print a structured JSON-ish summary with the vault id, ingest workflow run id, the file it wired into, and "next steps"

   You can override the wired file with \`--wire-into <path>\`, skip wiring with \`--no-wire\`, or skip ingest with \`--no-ingest\`. The \`--model\` flag also works on \`nia vault ingest/sync/lint\` directly.

**Special case: "index my life" / "index my Mac" / personal data trigger phrases.** When the user wants to ingest personal data (iMessage, Safari, Notes, Contacts, etc.), use the \`nia personal init --yes --vault "<name>"\` shortcut from the Personal Data section above. It does discovery + registration + vault creation + ingest in a single command. Example:

\`\`\`
nia personal init --yes --vault "My Life"
\`\`\`

This is strictly better than running \`nia personal init\` and \`nia vault init\` separately because the personal command captures pre-existing personal sources too, so the resulting vault is comprehensive on a re-run.

5. **Capture the vault id from the \`init\` output and tell the user what happened.** Report: vault id, name, sources count, ingest status, the file you wired into. Tell them they can immediately ask follow-up questions and you'll use the vault as your working memory in this conversation.

6. **Use the vault IMMEDIATELY in the same conversation.** You don't need to wait for the user to restart the agent. The vault id is already in your context. Use it via:
   - \`nia vault search <id> "..."\` for semantic queries
   - \`nia vault open <id> --c "tree && cat /index.md"\` to see what got generated
   - \`nia sources read <id> /concepts/<page>.md\` for specific pages
   - \`nia vault open <id> --c "echo '## My finding' >> notes/<topic>.md"\` to write notes (auto-protected from sync)

   While ingest is still running, the wiki is being populated progressively. You can poll progress with \`nia vault info <id>\` and re-check \`nia sources tree <id>\` to see new pages appear. Don't block the user — answer their questions with whatever's available, even if ingest hasn't finished.

7. **After ingest completes, optionally run \`nia vault lint <id>\`** to surface orphans / stale pages. Tell the user about anything they should review. Then you're done — the vault is live and persisted.

##### Failure modes — handle gracefully, don't fail the whole flow

- **No sources at all**: walk the user through indexing their first source. Don't try to create an empty vault. Ask what they want to track and use the appropriate index command.
- **Source still indexing**: don't fail the whole flow. Tell the user the source isn't ready yet. Either wait + retry, or proceed without that source and offer to add it later via \`nia vault add-source <vault-id> <source-id>\`.
- **Vault create succeeds but ingest fails**: the vault exists, just empty. Re-run \`nia vault ingest <vault-id>\` and explain. The \`init\` command's output will show \`ingest.status: "skipped"\` or surface an error message you can act on.
- **Ingest is slow** (>5 minutes): it's hitting Claude API rate limits or processing a large source. Don't cancel — tell the user to wait or come back later. Status is in \`nia vault info <vault-id>\`. The workflow will eventually complete or fail gracefully.
- **\`init\` couldn't auto-detect a project instructions file**: it falls back to creating \`CLAUDE.md\`. If the user is using Cursor/Codex, suggest they rename it to \`AGENTS.md\` or re-run with \`--wire-into AGENTS.md\`.
- **The current directory is not a project** (e.g., user is in their home directory): pass \`--no-wire\` to skip the file append. Tell the user to run \`nia vault setup <id> >> CLAUDE.md\` later from their actual project directory.

##### Manual / lower-level path (if \`nia vault init\` is unavailable or you want fine-grained control)

If you'd rather orchestrate the steps yourself (e.g., for transparency or to add sources iteratively):

\`\`\`
nia sources summary                                            # 1. discover
nia vault create "<name>" --from-source <id1>,<id2>            # 2. create — capture id from output
nia vault ingest <vault-id>                                    # 3. trigger ingest
nia vault setup <vault-id> | claude                            # 4. pipe guided onboarding to wire it in
# OR direct file append:
nia vault agents <vault-id> >> CLAUDE.md                       # 4. (alternative) append static block
nia vault info <vault-id>                                      # 5. poll status
\`\`\`

\`nia vault setup <id> | claude\` pipes a guided onboarding prompt into the agent — the agent will ask the user "file or skill or both?" and walk them through it. \`nia vault agents <id> >> CLAUDE.md\` is the direct one-shot file append (no agent interaction).

##### When to suggest creating a vault

Suggest a vault when:
- The user is **building understanding across multiple sources** ("I'm studying transformer attention across these papers and repos")
- The user wants **persistent memory across sessions** ("remember what we figured out last time")
- You find yourself **re-reading the same sources** to answer related questions in one conversation
- The user is doing **research, due diligence, course notes, competitive analysis** — anything that compounds

Don't create a vault for a one-off question. Use \`nia search query\` for those.

##### Lifecycle

- **Create** with seed sources: \`nia vault create "<name>" --from-source <source-id>[,<source-id>...]\`
- **Inspect**: \`nia vault list\`, \`nia vault info <vault-id>\`, \`nia vault list-sources <vault-id>\`
- **Add/remove sources later**: \`nia vault add-source <vault-id> <source-id>\`, \`nia vault remove-source <vault-id> <source-id>\`
- **Edit conventions**: \`nia vault update-schema <vault-id> <local-schema.md>\` (replaces \`/schema.md\`)
- **Delete** (cleans up Postgres + TurboPuffer): \`nia vault delete <vault-id>\`

##### The agent loop: ingest → query → lint → sync

These run as background Hatchet workflows. Trigger them and poll status with \`nia vault info <id>\`.

1. **\`nia vault ingest <vault-id>\`** — for each linked source that has no wiki page yet, an LLM reads the source and writes new \`concepts/*.md\` + \`entities/*.md\` pages with \`[[backlinks]]\` and source citations. Updates \`/index.md\`, appends to \`/log.md\`. **Idempotent by default** — sources that already have pages are skipped. Pass \`--force\` to re-synthesize everything.
2. **Query the vault** as you would any indexed source (see "Reading and writing" below).
3. **\`nia vault lint <vault-id>\`** — walks the vault, finds orphan pages (no inbound \`[[backlinks]]\`) and stale pages, writes a fresh \`/lint-report.md\`. Read it via \`nia sources read <vault-id> /lint-report.md\`.
4. **\`nia vault sync <vault-id>\`** — for each existing wiki page where the underlying source has been re-indexed since the page was generated, the LLM regenerates the page. **Skips any page with \`provenance.last_human_edit\` set** — i.e. anything you or the user edited via the bash session is preserved.
5. **\`nia vault refresh <vault-id>\`** — combined ingest + sync in one locked pass. Picks up new sources AND regenerates stale pages. **This is the same mode the daily auto-sync cron uses** — safe to run repeatedly because ingest is idempotent.
6. **\`nia vault cancel <vault-id>\`** — abort an in-flight workflow run.

##### Auto-sync (daily cron, on by default)

Every vault is auto-refreshed once a day by the server-side \`vault_polling_workflow\` (Hatchet cron at 09:00 UTC). It walks every vault where \`auto_sync_enabled\` is True (the default) and triggers \`mode=refresh\` for each. Refresh runs idempotent ingest followed by sync — new sources get pages, stale pages get regenerated, human-edited pages stay untouched.

- **Toggle per-vault**: \`nia vault auto-sync <vault-id> on|off\`
- **Trigger immediately**: \`nia vault refresh <vault-id>\`
- **Status**: visible in \`nia vault info <vault-id>\` as \`auto_sync_enabled\` and \`workflow_status\`

For the underlying personal-data sources (the layer below the vault), sync is **client-pushed** — the server can't read your local files. To keep them fresh in the background without thinking about it: run \`nia local install-watcher\` once. It installs a macOS LaunchAgent that runs \`nia local watch\` at every login and auto-restarts on crash. After that, your local sources stay fresh, the daily vault cron picks up changes, and the wiki self-evolves end-to-end.

While a workflow is running, vault writes from outside (your bash session, \`nia sources write\`, etc.) are **rejected with a 400** to prevent the vault from being corrupted mid-rewrite. The lock releases automatically when the workflow finishes.

##### Reading and writing inside a vault

Two equivalent surfaces. Use whichever fits your tool loop.

**Surface A — one-shot via existing \`nia sources\` commands.** Vaults are stored as \`data_sources\` rows with \`source_type=vault\`, so the standard source ops all accept a vault id:

\`\`\`
nia sources tree <vault-id>
nia sources ls <vault-id> --path /concepts
nia sources read <vault-id> /index.md
nia sources read <vault-id> /concepts/foo.md --line-start 1 --line-end 50
nia sources grep <vault-id> "thundering herd"
nia sources find <vault-id> "concepts/*.md"
nia sources write <vault-id> /notes/finding.md --body "..."
nia sources mkdir <vault-id> /notes/research
nia sources mv <vault-id> /notes/old.md /notes/new.md
nia sources rm <vault-id> /notes/test.md
\`\`\`

**Surface B — interactive bash session via \`nia vault open\`** (recommended for multi-step exploration). Drops you into a writable \`just-bash\` shell with the vault mounted as the filesystem at \`/\`. Every read, write, grep, and pipe persists to Postgres immediately:

\`\`\`
nia vault open <vault-id>                                  # interactive REPL
nia vault open <vault-id> --c "tree && cat /index.md"     # one-shot, ideal for tool loops
nia vault open <vault-id> --c "grep -rl 'attention' concepts/"
nia vault open <vault-id> --c "echo '## Note' >> notes/today.md"
\`\`\`

Inside the session you have full Unix tools: \`tree\`, \`cat\`, \`grep\`, \`find\`, \`head\`, \`tail\`, \`wc\`, pipes, redirects (\`>\`, \`>>\`), here-docs, \`mkdir\`, \`mv\`, \`rm\`, \`cp\`. Everything bash supports flows through to Postgres via the \`RemoteVaultFs\` IFileSystem layer.

**Surface C — semantic search** when the user's question is conceptual rather than literal:

\`\`\`
nia vault search <vault-id> "how does this codebase handle retries"
\`\`\`

This does hybrid TurboPuffer + Postgres grep against the vault namespace and returns ranked pages with line-level matches.

##### Wiki layout (every vault has these files)

\`\`\`
/schema.md         User-owned wiki conventions. NEVER overwritten by sync.
                   The LLM reads this on every ingest/sync/lint as context.
                   Edit it freely to evolve how the agent maintains the wiki.
/index.md          Auto-maintained catalog of every page. Don't edit by hand.
/log.md            Append-only chronological log of ingests/syncs/lints.
/META.md           Vault snapshot (id, sources, timestamps). Auto-maintained.
/concepts/*.md     LLM-generated concept pages. Use [[backlinks]] for cross-refs.
/entities/*.md     LLM-generated entity pages (people, products, libraries, papers).
/notes/*.md        User-curated freeform pages. Sync ALWAYS respects these.
/lint-report.md    Latest output of \`nia vault lint\`.
\`\`\`

##### The "leave alone" rule (CRITICAL — read this carefully)

When you write to a vault file from a bash session or via \`nia sources write\`, the backend automatically stamps \`provenance.last_human_edit\` on that file's PG row. The \`vault sync\` workflow MUST skip any page with \`last_human_edit\` set.

Practical implications:
- **Edits you make in the bash session are protected.** Background sync will not nuke them.
- **Pages under \`/notes/\` are always safe to edit** — they're user-curated and never auto-regenerated.
- **Pages under \`/concepts/\` and \`/entities/\` are auto-generated.** If you edit one, sync will permanently respect your edit going forward — you've effectively "frozen" that page from automatic refresh until you delete it (then the next ingest will recreate it from scratch).
- **\`/schema.md\` is always user-owned.** Edit it freely; the LLM picks up new conventions on the next ingest/sync/lint.

##### Wiring a specific vault into the current project

\`nia vault setup <vault-id>\` prints a CLAUDE.md/AGENTS.md block with the vault id pre-filled and the right commands. Append it to the project's instructions file so the agent knows which vault to use for THIS project:

\`\`\`
nia vault setup <vault-id> >> CLAUDE.md      # Claude Code
nia vault setup <vault-id> >> AGENTS.md      # Cursor / Codex / OpenCode / etc.
nia vault setup <vault-id> | claude           # pipe directly into a Claude Code session
nia vault skill <vault-id> > .claude/skills/<name>-vault/SKILL.md  # install as a per-vault skill
\`\`\`

This is **per-vault**, in addition to this global \`nia\` skill which teaches you that vaults exist as a concept. Use both: this global skill tells you about the vault loop in general; the per-vault setup tells you about ONE specific vault by id.

#### Defaults

- **Always check for \`nia.json\` first** (Step 0 above). It's the per-project source binding. \`nia search query\` auto-scopes when present.
- Use \`nia search query\` for targeted questions about specific repos, docs, papers, datasets, or local folders.
- For docs, index the **root URL**, not a single page. Example: \`https://docs.stripe.com\`.
- Most commands accept flexible identifiers such as UUID, display name, or URL.
- Use \`nia sources subscribe <url>\` for instant access to already-indexed global sources.
- For multi-source research that should compound across sessions, suggest a vault: \`nia vault create\` then \`nia vault ingest\`. See "Knowledge Base Vaults" above.
- For source enumeration at scale, use \`--all\` (e.g. \`nia sources list --all\`) instead of piping through \`head\` or \`tail\`. Pagination misses are the #1 cause of "agent picked the wrong source" bugs.
			`,
		}),
	);

await main.execute();
