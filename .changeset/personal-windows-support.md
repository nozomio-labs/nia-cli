---
"@nozomioai/nia": minor
---

Windows support for `nia personal`

Extends `nia personal` beyond macOS with platform-aware discovery. Six sources whose schemas and directory shapes are identical (or inherently cross-platform) now discover, register, and sync on Windows with no backend changes:

- **Chrome history** — `%LOCALAPPDATA%\Google\Chrome\User Data\<Profile>\History` (Default, then Profile N)
- **Firefox history** — `%APPDATA%\Mozilla\Firefox\Profiles\<profile>\places.sqlite`
- **Obsidian vault** — `.obsidian`-probe under Documents / OneDrive-redirected Documents / `iCloudDrive\iCloud~md~obsidian\<vault>`
- **VSCode workspaces** — `%APPDATA%\Code\User\workspaceStorage`
- **Cursor workspaces** — `%APPDATA%\Cursor\User\workspaceStorage`
- **Claude Code sessions** — `~/.claude/projects` (homedir-resolved)

Mac-only entries (iMessage, Safari, Notes, Contacts, Reminders, Stickies, etc.) keep their default `platforms: ["darwin"]` and are filtered out of discovery on Windows rather than reported as "not found". macOS behavior is unchanged.
