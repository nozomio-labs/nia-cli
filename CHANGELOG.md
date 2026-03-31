# nia-cli

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
