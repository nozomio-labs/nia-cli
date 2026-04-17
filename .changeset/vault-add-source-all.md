---
"@nozomioai/nia": minor
---

Add `--all` flag to `nia vault add-source` for bulk-adding every available indexed source to a vault in one command. The `source-id` argument is now optional when `--all` is set; otherwise required as before. Per-source failures are logged and skipped so a single bad source won't abort the batch.
