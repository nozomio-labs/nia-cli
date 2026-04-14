---
"@nozomioai/nia": minor
---

Typed personal-data extractors and SQLite WAL fix for macOS databases

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
