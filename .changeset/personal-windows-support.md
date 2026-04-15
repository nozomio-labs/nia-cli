---
"@nozomioai/nia": minor
---

Windows support for `nia personal`

Extends `nia personal` beyond macOS with platform-aware discovery. Eight sources now discover, register, and sync on Windows with no backend changes:

**Cross-platform** (schema/directory shape identical to macOS):

- **Chrome history** — `%LOCALAPPDATA%\Google\Chrome\User Data\<Profile>\History` (Default, then Profile N)
- **Firefox history** — `%APPDATA%\Mozilla\Firefox\Profiles\<profile>\places.sqlite`
- **Obsidian vault** — `.obsidian`-probe under Documents / OneDrive-redirected Documents / `iCloudDrive\iCloud~md~obsidian\<vault>`
- **VSCode workspaces** — `%APPDATA%\Code\User\workspaceStorage`
- **Cursor workspaces** — `%APPDATA%\Cursor\User\workspaceStorage`
- **Claude Code sessions** — `~/.claude/projects` (homedir-resolved)

**Windows-exclusive**:

- **Windows Timeline** — generic-tier. Scans `%LOCALAPPDATA%\ConnectedDevicesPlatform\<device-hash>\ActivitiesCache.db` (modern device-hash form or older `L.<username>`). Backend's generic TEXT-column walker ingests it today; a dedicated schema-aware extractor is a clean follow-up.
- **PowerShell history** — folder-tier. Registers `%APPDATA%\Microsoft\Windows\PowerShell\PSReadLine\`, which captures `ConsoleHost_history.txt` plus per-host history files (VSCode integrated terminal, ISE). Off by default — shell history can leak pasted secrets.

Mac-only entries (iMessage, Safari, Notes, Contacts, Reminders, Stickies, etc.) keep their default `platforms: ["darwin"]` and are filtered out of discovery on Windows rather than reported as "not found". macOS behavior is unchanged.
