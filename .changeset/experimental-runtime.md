---
"@nozomioai/nia": patch
---

Add runtime experimental mode override system

- Add `--experimental` flag support for single command invocations without persisting to config
- Root-level usage with `--experimental` persists the preference to config
- Subcommands use runtime override only for the active invocation
- Add comprehensive tests for runtime override behavior
