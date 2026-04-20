---
"@nozomioai/nia": patch
---

refactor: `nia project init` no longer bootstraps the project root — removes automatic CLAUDE.md/AGENTS.md wiring and automatic `nia local add .`

Previously, `nia project init` would (1) append a `## Nia (project-scoped)` block to CLAUDE.md / AGENTS.md / GEMINI.md / CURSOR.md in the cwd (creating CLAUDE.md if none existed), and (2) register the cwd as a local folder source via `addLocalSource(cwd)` by default. Both side effects mutated the user's project without explicit consent.

Now:

- **No agent-instruction files are touched.** The global `nia` skill (installed via `nia skill`) is the sole delivery channel for `nia.json` guidance — Step 0 of the skill already teaches agents to detect and use `nia.json` automatically. The `--wire` / `--wire-into` flags are removed.
- **No automatic `addLocalSource(cwd)`.** The `--local` flag is removed. Before the source picker, `init` now asks `Index the current project folder (<cwd>) as a local source?` — defaults to **No**. Only if the user answers yes does it call `addLocalSource(cwd)` and add a `local` binding to `nia.json`.
- **Skill install nudge.** After writing `nia.json`, `init` best-effort-detects whether the `nia` skill is installed for any agent (via `detectInstalledAgents` + `skillStatus`, wrapped in a 1.5s timeout). If not, `next_steps` includes `"Install the nia skill: nia skill"`.
- Core logic is factored into an exported `runProjectInit()` with dependency-injected picker / `addLocalSource` / skill-check callbacks, so the file-writing behavior can be tested without spinning up a real interactive prompt or hitting the daemon.

The skill's `instructions` block in `src/cli.ts` (Step 0 — check for `nia.json`) has been updated to reflect the new `init` behavior.
