# nia-cli

## 0.3.0

### Minor Changes

- 80b641c: Typed personal-data extractors and SQLite WAL fix for macOS databases

  **Core fix**: SQLite databases in WAL mode (iMessage, Notes, WhatsApp, etc.) failed with "unable to open database file" because only the main `.db` file was copied to temp — missing the `-wal` and `-shm` companions. Additionally, opening the copy with `readonly: true` prevented WAL recovery. Both issues are now fixed in `extractors/shared.ts`.

  **New typed extractors** for 7 macOS personal-data sources, each with schema-aware column selection and structured output:

  - WhatsApp — chat history with sender/group metadata
  - Apple Notes — folders, notes, and attachment metadata
  - Apple Contacts — names, emails, phones, organizations
  - Apple Reminders — lists, items, due dates, completion state
  - Apple Podcasts — subscriptions, listening history, episode metadata
  - Apple Photos (metadata) — faces, places, dates, albums
  - Screen Time / knowledgeC — app launches, web visits, focus modes

  **Other improvements**:

  - `nia local doctor` command for diagnosing extraction issues
  - Error classification in sync output (permission errors vs database errors vs extraction failures)
  - Schema-adaptive extractors for Photos and Reminders that handle varying column names across macOS versions
  - Temp SQLite copy cleanup on extraction failure

## 0.2.3

### Patch Changes

- Pin CI bun version to 1.3.11 to fix broken cross-compiled binaries (bun 1.3.12 produces hanging darwin-arm64 binaries)

## 0.2.2

### Patch Changes

- Fix broken 0.2.1 binary that hangs on all commands

## 0.2.1

### Patch Changes

- 196dd76: Add dream cycle commands and update vault templates

  - `nia vault dream <id>` — self-improving dream cycle that discovers entities, finds cross-source connections, detects contradictions, and writes dream-report.md
  - `nia vault auto-dream <id> on|off` — toggle weekly automatic dream cycle (Sunday 3am UTC)
  - Updated agent instruction templates (agents md + skill md) with dream report, compiled truth + timeline page structure, and typed wikilinks documentation

## 0.2.0

### Minor Changes

- **Self-evolving vaults.** Knowledge bases now auto-refresh on a schedule end-to-end without any manual intervention.

  **Two new layers**:

  1. **Backend `vault_polling_workflow`** — Hatchet cron at 09:00 UTC daily that walks every vault where `auto_sync_enabled` is True (the default) and triggers a `refresh` run. Refresh is a new vault_workflow mode that runs idempotent ingest (only sources without existing pages) followed by sync (regenerate stale pages whose underlying source has been re-indexed). Both phases share the per-vault reentrancy lock and respect the per-user concurrency limit on `vault_workflow` so triggering 50 vaults per user just queues them.

  2. **Macos LaunchAgent installer** — `nia local install-watcher` writes `~/Library/LaunchAgents/ai.nia.watch.plist`, bootstraps it via `launchctl`, and verifies it loaded. The agent runs `nia local watch` at every login with `KeepAlive` on crash, so personal-data syncs flow continuously to the backend without the user thinking about it. The daily vault cron then picks up the new content and refreshes the wiki.

  **Idempotency in `vault_workflow.run_ingest`**: a new `_source_has_pages(namespace, source_id)` helper queries the partitioned `files` table for any page whose `headers->'provenance'->'source_ids'` JSONB column contains the source. Sources with existing pages are skipped (sync mode handles those). Pass `--force` on `nia vault ingest` / `nia vault refresh` to override and re-synthesize.

  **New CLI commands**:

  - `nia vault refresh <id> [--force]` — combined idempotent ingest + sync in one locked pass. Same mode the cron uses.
  - `nia vault auto-sync <id> on|off` — toggle the daily auto-refresh per vault.
  - `nia local install-watcher` — install the LaunchAgent for background sync.
  - `nia local uninstall-watcher` — remove it.
  - `nia local watcher-status` — show pid, last exit, and log tail.

  **New fields**:

  - `Vault.auto_sync_enabled: bool = True` (Pydantic + serialization)
  - `VaultWorkflowInput.mode` now accepts `"refresh"`
  - `VaultWorkflowInput.force: bool = False`
  - `VaultUpdateRequest.auto_sync_enabled: Optional[bool]`

  **Files added**: `backend/workflows/vault_polling.py`, `nia-cli/src/services/local/watcher-install.ts`.

  **Files modified**: `backend/workflows/vault_workflow.py` (idempotency + refresh mode), `backend/models.py`, `backend/routes/v2/vaults.py` (PATCH + run + serialize), `backend/worker/hatchet_worker.py` (registration), `nia-cli/src/commands/vault.ts` (refresh + auto-sync + force flag), `nia-cli/src/commands/local.ts` (install-watcher + uninstall + status), `nia-cli/src/commands/personal.ts` (next-step hints), `nia-cli/src/cli.ts` (skill instructions).

- **Cross-collection bridge so `nia sources read|grep|tree|ls` works against personal-data sources**, plus a telemetry parity pass over the vault and shell-docs surfaces.

  ## The bug

  Personal-data sources from `nia personal init` (iMessage, Apple Notes, Chrome history, Cursor / VSCode workspace history, Claude Code session history, Obsidian, Calendar, etc.) live in `db.local_folders`, not `db.data_sources`. The documentation read/grep/tree/ls handlers only resolved IDs from `db.data_sources`, so any `nia sources grep <personal-source-id> "pattern"` returned **"Data source not found"** — even though `_resolve_namespace` in `routes/v2/fs.py` already handles both collections for the lower-level `/v2/fs/...` primitives, and even though the same source IDs round-trip through `nia vault list-sources` and `nia search query --local-folders`.

  ## The fix

  Added a `_try_local_folder_as_data_source` helper to `routes/v2/data_sources.py` that, after the standard `db.get_data_source_by_id` lookup misses, falls back to `db.local_folders.find_one(...)`, runs the same ownership check, and returns a synthetic data_source dict with `source_type="local_folder"`. The existing PG-backed fast path (originally added for vaults) is widened to also serve `local_folder` source_type. Both kinds dispatch directly to `fs_service.grep` / `fs_service.read_file_content` / `fs_service.list_directory` / `fs_service.get_tree` and bypass the URL→path translation cascade entirely.

  Patched in 4 documentation handlers:

  - `grep_documentation_v2` — supports `nia sources grep <local-folder-id> "pattern"`
  - `read_documentation_file_v2` — supports `nia sources read <local-folder-id> <path>` and tries both `path` and `/path` variants since vault paths have leading slashes (`/concepts/foo.md`) but local-folder paths are naked (`urls/row_42.txt`, `sessions-index.json`)
  - `list_documentation_directory_v2` — supports `nia sources ls <local-folder-id>`
  - `get_documentation_tree_v2` — supports `nia sources tree <local-folder-id>`

  The grep fast path also normalizes the default `path="/"` filter to `None` for local-folder sources since their paths don't start with `/` (the prefix would otherwise exclude every file).

  After this, you can `nia sources grep <claude-code-source-id> "2026-04-04T16"` to find Saturday-morning conversation chunks, `nia sources tree <chrome-history-id>` to walk the Chrome SQLite extraction, `nia sources read <obsidian-id> path/to/note.md` to fetch an Obsidian note, etc.

  ## Telemetry parity pass

  While auditing the documentation handlers I noticed three gaps in the v2 telemetry surface and closed them in the same change:

  1. **Vault grep fast path was missing both `store_api_activity` and `store_retrieval_log`.** The huggingface grep fast path emits both (one for the user-facing activity feed, one for the training-data retrieval pipeline). Vault grep was bypassing both. The widened fast path now emits the same telemetry surface for vault AND local-folder grep — every retrieval against a PG-backed source now appears in the activity feed and the training-data pipeline alongside documentation/repository/HF retrievals.

  2. **Vault `/search` endpoint was emitting neither `api_activity` nor `retrieval_log`.** Other v2 search paths (search query, search universal, repos search, packages search, etc.) all log to `db.retrieval_logs` with the appropriate `RetrievalCapture` so the training data pipeline sees them. Vault searches were invisible to that pipeline. Added both: a `vector_match` capture for the TurboPuffer hybrid path (`retrieval_method="hybrid"`) and a `grep_result` capture for the PG fallback (`retrieval_method="regex"`). Both are scheduled as fire-and-forget tasks so logging failures never fail the search response.

  3. **All 8 shell-docs endpoints were missing `@track_endpoint_performance`.** They had `@handle_endpoint_errors` for error capture but no PostHog/perf metric emission, so shell-docs latency / error-rate never appeared in dashboards alongside other v2 routes. Added the decorator to all of: `index`, `status`, `telemetry`, `read`, `grep`, `ls`, `tree`, `find`, `load`, `dump`, `info`. The decorator lives in `routes/v2/auth.py` (not `utils/error_handlers.py`); imported from there.

  ## Verified live

  - `nia sources tree c25cf74f-...` (Claude Code) → 127 files, `source_type: local_folder`, `tree_type: fs_tree`
  - `nia sources grep c25cf74f-... "sessionId"` → 100 matches across 17 files
  - `nia sources grep c25cf74f-... "2026"` → 109 matches, 16 files
  - `db.retrieval_logs.find({query_type:"doc_grep"})` → 3 entries with namespace=`local-folder_user_..._c25cf74f...` and `method=regex` — proves both the cross-collection grep AND the retrieval logging fire end-to-end
  - `db.api_activities.find({query_type:"vault_search"})` → entry with `results_count`, `performance_ms`, `query_type=vault_search`
  - Direct curl `/v2/data-sources/.../read` against a local-folder file with leading-dash path → 200 OK with `source_type: local_folder` in metadata

  ## Files changed

  - `backend/routes/v2/data_sources.py` — `_try_local_folder_as_data_source` helper, cross-collection branch in 4 handlers, vault fast path widened to handle local_folder, telemetry calls added to vault/local-folder grep fast path, namespace path normalization
  - `backend/routes/v2/vaults.py` — vault search retrieval_log + api_activity wiring
  - `backend/routes/v2/shell_docs.py` — `track_endpoint_performance` import + decorators on all 11 endpoints

  ## Known issue (separate fix)

  The CLI's positional-arg parser strips a leading `-` from `<path>` arguments, so `nia sources read <id> -Users-arlanrakhmetzhanov-Developer-nia-app/sessions-index.json` fails with "Missing required argument". The backend handler works correctly via direct curl. Tracking as a separate small CLI fix.

- Expand `nia personal` from 8 macOS sources to **35+ across 4 tiers**, leveraging the backend's existing dedicated extractors AND its `extract_generic()` SQLite-walker fallback (db_extractor.py:1521-1522) so most sources ship with zero new backend code.

  **Tier 1 — dedicated backend extractors** (full schema awareness): iMessage, Safari history, Chrome history, Firefox history, Telegram Desktop. Five sources, ready to ship today.

  **Tier 2 — generic SQLite extraction** (functional, schema-blind, ships today via the dispatcher's `else: extract_generic(db_path)` fallback): Apple Notes, WhatsApp, Apple Reminders, Apple Contacts, Apple Books library, Apple Books annotations, Apple Podcasts, Anki, Day One journal, Bear Notes, Things 3, OmniFocus, Apple Photos metadata (faces/places/dates/captions/albums — NOT image bytes), **Screen Time / knowledgeC.db** (the killer behavioral source — app launches, web visits across all browsers, focus modes, screen unlocks, ~90 days of data), Significant Locations (where you've physically been), Voice Memos metadata.

  **Tier 3 — folder mode** (the daemon's local-folder walker handles directory trees of text files): Apple Mail (`~/Library/Mail/V*` with `.emlx` files), Apple Calendar (`~/Library/Calendars` with `.ics` files), Stickies (RTF files), Obsidian vault (auto-discovered by probing for `.obsidian/`), iCloud Drive, Documents folder, Downloads folder, Desktop folder.

  **Tier 5 — developer brain dump**: VSCode workspaceStorage, Cursor workspaceStorage, Claude Code session history (`~/.claude/projects/<proj>/conversations/*.jsonl`).

  **Tier 6 — discoverable but no extractor yet** (surfaced in `nia personal status` for roadmap visibility): Voice Memos audio (needs Whisper transcription), Screenshots (needs OCR), Discord/Signal/Slack desktop caches (Electron LevelDB / encrypted SQLite), shell history files, installed apps snapshot.

  **Smart auto-discovery**: glob-style probing for sources that live behind random path keys — Firefox profile dirs, Anki collections, Apple Books versioned databases (`BKLibrary-*.sqlite`, `AEAnnotation-*.sqlite`), Photos.sqlite inside the photoslibrary package, Contacts AddressBook UUID-keyed sources, OmniFocus 3 vs 4, Obsidian vaults under `~/Documents/`.

  **Tier system on `PersonalSourceSpec`**:

  - `extractorTier: "dedicated" | "generic" | "folder" | "none"` — what backend support exists
  - `dbType: string | null` — what's sent to the daemon's `detected_type` field (preserves source identity in MongoDB while routing to the right extractor)
  - `autoEnable: boolean` — whether `nia personal init` (without flags) registers this. Curated default of "essential personal data" (~12 sources); high-volume / sensitive / niche sources (Photos, Screen Time, Significant Locations, Anki, Day One, Bear, Things, OmniFocus, iCloud Drive, Documents, Downloads, Desktop, etc.) require explicit `--enable <connector>` or `--all` to opt in.

  **`--all` flag** added to `nia personal init` for the "give me everything you can find" path (alias for `--enable all`).

  **`--vault-model <model>` flag** added to `nia personal init` to override the LLM model used for the auto-created vault's ingest workflow. Defaults to backend's `claude-sonnet-4-5-1m` (1M context).

  **`nia personal status`** now groups output by tier and reports the full breakdown: total known sources, discovered, readable, blocked on permissions, ready to register, needs new backend extractor.

  **Path-based deduplication**: in addition to connector-key matching, the discovery cross-references existing sources by resolved path so folder-mode sources (which all share `detected_type=folder`) don't get double-registered when re-running init.

- Add `nia personal init/status/sync` for one-command macOS personal-data ingestion.

  **`nia personal init --yes`** auto-discovers iMessage, Safari history, Apple Notes, Contacts, Reminders, Stickies, and Voice Memos at standard macOS paths and registers each as a local-folder source via the daemon endpoint with the right `detected_type` so the backend's `db_extractor.py` extractors run automatically. Idempotent (skips already-registered sources), dry-run-able (`--dry-run`), and detects EACCES on protected paths to tell the user how to grant Full Disk Access.

  **`nia personal init --yes --vault "My Life"`** chains discovery + registration + vault creation + ingest into a single shell call. This is the "index my life" command — fulfills the trigger in one shot from an autonomous agent.

  **Vault ingest workflow upgrades** (`backend/workflows/vault_workflow.py`):

  - Default model is now `claude-sonnet-4-5-1m` (1M-token context window via `anthropic-beta: context-1m-2025-08-07` header), matching the convention from `services/document_agent_service.py`. Adaptive thinking enabled for Opus 4.6, manual thinking for other models — same pattern as `utils/anthropic_helpers.py`. Uses `create_async_client` from `utils/anthropic_client.py` so Bedrock vs direct API works transparently.
  - Source content cap raised from 60,000 chars / 50 files → **600,000 chars / 500 files** for 1M-context models (10x), with smaller fallback caps for non-1M variants. The LLM now reads small repos and doc sites in full instead of a sample, dramatically improving wiki page quality.
  - Ingest prompt rewritten to ask for 3-15 pages per source (was 1-5), encourages aggressive `[[backlinks]]` cross-linking, and uses a system+user prompt structure instead of one giant user prompt.
  - `nia vault init` and `nia vault ingest/sync/lint` accept a new `--model` flag to override the default.

  **Global skill update** (v0.0.17 → v0.0.18): every supported AI agent now knows about both the personal-data flow and the 1M-context vault default. The skill instructions teach the autonomous "index my life" pattern with `nia personal init --yes --vault "My Life"` as the canonical one-shot.

- Wire **client-side SQLite extraction** into the local sync pipeline so Tier 2 personal-data sources (Apple Notes, Reminders, Contacts, Books, Podcasts, Anki, Day One, Bear, Things, OmniFocus, Photos metadata, Screen Time, Significant Locations, Voice Memos, etc.) actually produce content end-to-end.

  Until this release, `nia personal init` would happily register a Tier 2 source via the daemon endpoint, but `nia personal sync` only had a folder walker — and SQLite files (`.sqlite`, `.sqlite3`, `.db`) are explicitly blacklisted in `SKIP_EXTENSIONS`. Vault ingest from a personal-data source produced **0 wiki pages** because no chunks ever made it to the backend.

  **What's new**:

  - New `extractSqliteSource(sourcePath, connectorKey, options?)` in `src/services/local/extractor.ts`. Uses Bun's built-in `bun:sqlite` (no new dependencies).
  - Resolves directory paths to actual SQLite files via a 4-level recursive walk for `.sqlite` / `.sqlite3` / `.db` / `.abcddb` / `.storedata`. Handles versioned-DB cases like `BKLibrary-*.sqlite` (Apple Books) and `AEAnnotation-*.sqlite` (annotations) automatically.
  - Copies the SQLite file to `os.tmpdir()/nia-personal-sqlite/<connector>-<mtime>-<filename>` before opening so we never contend with apps that hold the DB open (Chrome's `History.db`, etc.). Cache key includes mtime so re-runs reuse the copy.
  - Walks every user table via `sqlite_master`, finds TEXT-ish columns via `PRAGMA table_info`, emits one virtual file per row in `<safeTableName>/row_<pk>.txt` format with metadata `{source_type: "local_folder", source_subtype: "database", db_type: connectorKey, table, row_id}`. Skips internal tables (`sqlite_*`, FTS shadow tables).
  - Caps: 5000 rows per table, 50000 total rows per source — same order of magnitude as the backend's `extract_generic`.

  **Sync dispatch** (`src/services/local/sync.ts`): `syncLocalSource` now branches on `source.detected_type`:

  - `folder` or empty → `extractFolderIncremental` (existing behavior, unchanged)
  - anything else (e.g., `notes`, `books`, `screen_time`, `anki`) → `extractSqliteSource(sourcePath, detected_type)`

  The `connector_type` field on the upload payload now reflects the real `detected_type` instead of being hardcoded to `"folder"`, so the backend's daemon ingest path stamps each chunk with the right `db_type`.

  **Net effect**: `nia personal init --yes --vault "My Life"` now produces a vault that actually contains wiki pages derived from your personal data on the first run, without requiring any backend deploy.

- Add `nia vault` command family for agent-maintained personal wikis on top of indexed Nia sources (Karpathy-style "LLM Knowledge Bases" pattern).

  **New commands** (18 total under `nia vault`): `create`, `list`, `get`, `info`, `delete`, `rename`, `update-schema`, `add-source`, `remove-source`, `list-sources`, `ingest`, `sync`, `lint`, `cancel`, `search`, `setup`, `skill`, `open`.

  **The `vault open` subcommand** drops the user (or agent) into an interactive `just-bash` session with the vault mounted as a writable filesystem via a custom `RemoteVaultFs` IFileSystem implementation. Every read, write, grep, and pipe persists to Postgres immediately through the existing `/v2/fs/{id}/*` endpoints. Supports both interactive REPL mode and one-shot `--c "command"` mode for agent tool loops.

  **Autonomous setup**: a new `nia vault init "<topic>" --from-source <id1>,<id2>` one-shot command collapses create + ingest + wire-into-project into one atomic op. Auto-detects the project's instructions file (`CLAUDE.md` > `AGENTS.md` > `GEMINI.md` > `CURSOR.md` in cwd), appends a `## <Name> Vault` block to it, and creates `CLAUDE.md` if no file exists. Designed so an agent can fulfill "set me up with a vault for X" in a single shell call.

  **`nia vault setup` / `agents` / `skill` split** (mirrors nia-shell-docs's surface):

  - `nia vault setup <id>` now produces a **guided onboarding prompt** designed to be piped into an agent (`nia vault setup <id> | claude`) — the agent reads it as a meta-prompt, asks the user file vs skill vs both, and runs the right install command.
  - `nia vault agents <id>` (new) produces a static `## <Name> Vault` block to append to a project's instructions file (`nia vault agents <id> >> CLAUDE.md`).
  - `nia vault skill <id>` produces a `SKILL.md` with frontmatter; the duplicate-`H1` cosmetic bug is fixed.

  **Global skill update**: every supported AI agent (Claude Code, Cursor, Windsurf, Codex, OpenCode, Gemini CLI, Zed, Qwen Code, and 20+ others via `@crustjs/skills`) now learns about vaults at install time. The skill teaches the agent what a vault is, when to suggest creating one, the ingest/sync/lint workflow loop, the wiki layout, the "leave alone" rule for human-edited pages, and — crucially — the **autonomous setup playbook**: trigger phrases to recognize, the deterministic 7-step flow to execute, failure modes to handle gracefully, and the recommended `nia vault init` one-shot. The agent now knows it can fulfill "set me up with a vault for X" autonomously without asking permission.

### Patch Changes

- **Fix `nia sources read|write|mv|mkdir|rm` failing on positional paths that begin with `-`.**

  Surfaced when trying to read Claude Code session files via the new local-folder source bridge: `nia sources read <id> -Users-arlanrakhmetzhanov-Developer-nia-app/sessions-index.json` failed with `Error: Missing required argument "<path>"` because crustjs uses Node's `util.parseArgs` which treats anything starting with `-` as a flag.

  ## Root cause

  crustjs's parser respects the POSIX `--` separator (everything after `--` is a positional), but it puts the resulting values into `rawArgs`, not `args`. The 5 source-fs commands declared their `<path>` positionals with `required: true`, which made the parser throw "Missing required argument" before our `.run` handler could fall back to `rawArgs`.

  ## Fix

  For all 5 commands (`read`, `write`, `mv`, `mkdir`, `rm`):

  1. **Drop `required: true`** from the path positional schema (omitting the field is the only way to make it optional in crustjs's strict type system — `required: false` is rejected at compile time because the type is `required?: true`).
  2. **Validate at runtime** via a new `resolvePathArg(args[name], rawArgs, name, rawIndex)` helper that prefers `args[name]` and falls back to `rawArgs[rawIndex]`. If neither is present, throws a friendly error showing both calling conventions.
  3. **Update help text** to document the `--` workaround on each path argument.

  ## Calling conventions

  ```bash
  # Standard (most paths) — unchanged
  nia sources read <id> /concepts/foo.md
  nia sources read <vault-id> /entities/sam-altman.md --line-end 50

  # Dash-prefixed paths — pass after the POSIX `--` separator
  # Note: flags must come BEFORE `--`, since `--` ends flag parsing per POSIX
  nia sources read <id> --line-start 1 --line-end 4 -- -Users-arlan/sessions-index.json
  nia sources rm   <id> -- -Users-arlan/old-session.jsonl
  nia sources mv   <id> -- -Users-arlan/old.md -Users-arlan/new.md
  ```

  ## What unblocks

  This was the last gap blocking direct access to Claude Code, Cursor, and VSCode workspace history files via `nia sources read`, since their paths come from the daemon's path-sanitization step which encodes the original `/` slashes as `-` dashes (e.g. `/Users/arlanrakhmetzhanov/Developer/nia-app` → `-Users-arlanrakhmetzhanov-Developer-nia-app`).

  Combined with the previous release's local-folder bridge in the documentation handlers, you can now do precise timeline queries against your personal data:

  ```bash
  nia sources tree c25cf74f-... -- -Users-arlan-Developer-nia-app
  nia sources read c25cf74f-... --line-start 1 --line-end 100 -- -Users-arlan-Developer-nia-app/sessions-index.json
  nia sources grep c25cf74f-... "2026-04-04T16"
  ```

  ## Verified live

  - `nia sources read c25cf74f-... --line-start 1 --line-end 4 -- -Users-arlan/sessions-index.json` → `success: true`, lines 1–4, `source_type: local_folder`
  - `nia sources read 05691fa0-... /entities/sam-altman.md --line-end 5` → unchanged (vault regression check)
  - `nia sources read <id>` (no path) → helpful error showing both calling conventions

  ## Files changed

  - `nia-cli/src/commands/sources.ts` — `resolvePathArg` helper at module level + 5 command schema/runtime updates (`read`, `write`, `mv`, `mkdir`, `rm`)

## 0.1.1

### Patch Changes

- 8d9eca8: add non-TTY support for sandbox search steaming support
- 531318d: support short repo name

## 0.1.0

### Minor Changes

- a2621a6: Add `nia sources explore` command to browse globally indexed public sources from the CLI

## 0.0.15

### Patch Changes

- ed26230: add sandbox agentic search

## 0.0.14

### Patch Changes

- d328230: Add runtime experimental mode override system

  - Add `--experimental` flag support for single command invocations without persisting to config
  - Root-level usage with `--experimental` persists the preference to config
  - Subcommands use runtime override only for the active invocation
  - Add comprehensive tests for runtime override behavior

- 23fda20: Fix source registration and search formatting issues

  - Improve SDK source registration and status checking
  - Fix output formatting for search results display
  - Add comprehensive tests for source and search commands

- 62f10f8: Improve CLI error verbosity for debugging

  - Preserve structured HTTP error details so verbose mode can print response bodies and causes
  - Surface underlying backend messages more clearly in shared CLI error output
  - Wire inherited `--verbose` handling through command error wrappers and cover the behavior with tests

## 0.0.13

### Patch Changes

- Rename `nia document query` to `nia document agent` to clarify multi-step AI agent behavior.

## 0.0.12

### Patch Changes

- Add extract, document agent, deps, connectors, slack, gdrive, x commands. Add sources subscribe, write, mv, mkdir, rm, summary, upload subcommands. Update skill instructions for AI agent discovery.

## 0.0.11

### Patch Changes

- d1644c1: Add new CLI commands: extract (table/detect/engineering), document agent, deps (analyze/subscribe/upload), connectors, slack, gdrive, x integrations. Add sources subcommands: subscribe, write, mv, mkdir, rm, summary, upload.
- bf84003: Improve CLI compatibility and experimental API behavior across auth, usage, oracle, and sources commands. This includes persisting the `--experimental` API preference, normalizing usage output across multiple response shapes, and improving `nia sources resolve` multi-match output with clearer IDs and `nia search query` follow-up guidance.

## 0.0.10

### Patch Changes

- 7560ed9: Fix `nia sources sync` so it preserves the source type when recreating a source and removes the original source if the API returns a new ID.

## 0.0.9

### Patch Changes

- 0a3848d: fix papers list auth error

## 0.0.8

### Patch Changes

- 293c710: replace the shared formatter utility with the new output renderer module
- 2766445: clarify the indexed-first search workflow and move query search mode guidance to the command annotation
- 69a8e21: update dependencies
- 38beb0f: update licence

## 0.0.7

### Patch Changes

- ac1dc9c: update dependencies

## 0.0.6

### Patch Changes

- 99e0ce4: add local sync commands

## 0.0.5

### Patch Changes

- 8d3f316: set up per OS package distribution
- 44fdb48: add agent skills annotations
- da90696: fix index command in non-TTY

## 0.0.4

### Patch Changes

- a366693: fix skills update issue upstream

## 0.0.2

### Patch Changes

- c3f0568: first release
- a8b604a: improve error handling
- d701a1d: remove spinners
