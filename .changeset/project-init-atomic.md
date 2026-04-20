---
"@nozomioai/nia": patch
---

fix: `nia project init` is now atomic — no partial state if the user cancels midway or the daemon fails

Previously, `runProjectInit` could leave the user in awkward half-states:

- If the user opted in to registering the cwd as a local source but the daemon call failed, the command would still write `nia.json` (with an empty `local[]` array) plus a `local_binding_note: "Skipped..."` field. The manifest silently failed to match what the user asked for.
- If the user hit Ctrl+C during a prompt, the `CancelledError` bubbled up through `withErrorHandling` and was rendered as a generic "Error: ..." with an ugly message and exit code 1.

Now `nia project init` follows a strict two-phase contract:

1. **Gather phase** — all prompts (cwd opt-in confirm, fuzzy filter picker, optional "continue with empty?" confirm) run first. Zero filesystem or daemon side effects. Fully cancellable.
2. **Commit phase** — if the user opted in, `addLocalSource(cwd)` is called. On any failure (network, daemon down, missing `local_folder_id` in response) the whole init aborts with a clear error and **nothing is written**. Otherwise, `nia.json` is written in a single atomic step.

Additionally, `CancelledError` from `@crustjs/prompts` is now handled globally in `handleError`: any command that uses prompts will exit silently with code `130` (POSIX SIGINT convention) on Ctrl+C, instead of rendering a noisy error trace.

The `local_binding_note` field has been removed from the `runProjectInit` result and from the CLI output — it described a partial-success state that can no longer occur.
