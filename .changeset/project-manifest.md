---
"@nozomioai/nia": minor
---

feat: per-project `nia.json` manifest with auto-scoped search

Adds `nia project` command group (init, link, unlink, status, sync) that creates a `nia.json` manifest at the project root, pinning indexed sources to the project. Once present, `nia search query` auto-injects the bound source ids — agents no longer need to run `nia sources list | head -X` to discover sources, fixing the #1 failure mode at 100+ indexed sources.

- `nia project init`: interactive source picker, registers cwd as local folder, wires CLAUDE.md/AGENTS.md
- `nia project link/unlink`: add/remove sources by id, name, or URL with automatic resolution
- `nia project status`: per-source health (indexed / pending / orphaned / not-found)
- `nia project sync`: re-resolve identifiers to canonical ids
- `nia search query` auto-scopes from `nia.json` when no `--repos`/`--docs`/`--local-folders` flags are passed; `--no-scope` to bypass
- `--all` flag on `nia sources list`, `nia repos list`, and `nia sources explore` for exhaustive pagination instead of piping through `head`/`tail`
- Skill instructions updated with Step 0 (check for nia.json first)
