---
"@nozomioai/nia": patch
---

Improve CLI error verbosity for debugging

- Preserve structured HTTP error details so verbose mode can print response bodies and causes
- Surface underlying backend messages more clearly in shared CLI error output
- Wire inherited `--verbose` handling through command error wrappers and cover the behavior with tests
