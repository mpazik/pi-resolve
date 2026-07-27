# Changelog

## 0.1.0 (unreleased)

- Initial release of `pi-resolve`.
- Resolves `@file` and `` !`command` `` references in user input, system
  prompt, and skill content.
- Recursive `@file` import in markdown (depth 5), `~/` expansion, 100 KB
  size caps for files and command output.
- Settings file at `~/.pi/agent/pi-resolve.json` (global) and
  `<cwd>/.pi/pi-resolve.json` (project, overrides global) with:
  - per-source `files` / `commands` toggles for `userInput`, `systemPrompt`,
    and `skill`;
  - per-source `display` mode (`"always"` | `"never"` | `"errors"`)
    controlling when items appear in the TUI summary. Content sent to the
    model is unaffected.
