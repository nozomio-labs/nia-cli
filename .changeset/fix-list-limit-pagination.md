---
"@nozomioai/nia": patch
---

fix: paginate list endpoints so `nia project init` and `nia vault add-source --all` respect the API's `limit <= 100` cap

`nia project init` was calling `cliSdk.sources.list({ limit: 200 })` inside its source picker and `nia vault add-source --all` was calling `/vaults/available-sources?limit=500`. The Nia API now rejects both with `Validation error: query → limit: Input should be less than or equal to 100`, which broke the commands outright.

Adds a shared `paginateAll` helper in `src/services/pagination.ts` that walks list endpoints with `limit <= 100`, normalizes the response shapes Nia returns (`T[]`, `{ items }`, `{ sources }`), stops on a short page, and caps total items at 500 as a safety ceiling. `pickSources` in `commands/project.ts` and the `--all` branch of `vault add-source` now delegate to it.
