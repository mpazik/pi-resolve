# Changelog

## 0.1.0 (unreleased)

- Initial release of `pi-resolve`.
- Resolves `@file` and `` !`command` `` references in user input, system
  prompt, skill content, and opted-in extension commands through the
  `pi-resolve:resolve` shared event.
- Shared-event callers receive ordered structured outcomes and can select a
  file-only mode that never executes command references.
- Single-level `@file` imports, sorted immediate directory listings, and `~/`
  expansion. Configurable byte limits default to 100 KB per file or command
  capture and 1 MB total imported context per turn or shared request.
- Byte-bounded reads and subprocess capture reject special files, stop flooding
  output, and clean up POSIX process groups. Failed or omitted references produce
  explicit model-facing notices independently of TUI display.
- Settings file at `~/.pi/agent/pi-resolve.json` (global) and
  `<cwd>/.pi/pi-resolve.json` (project, overrides global) with:
  - per-source `files` / `commands` toggles for `userInput`, `template`,
    `systemPrompt`, `skill`, and explicit shared-resolver `extension` calls;
  - per-source `display` mode (`"always"` | `"never"` | `"errors"`)
    controlling when items appear in the TUI summary. Content sent to the
    model is unaffected. Shared callers own their UI.
- Commands default on for direct user input and trusted system/AGENTS.md context;
  templates, skills, and shared calls require opt-in. Automatic TUI summaries
  default on only for user input and templates. Files default on everywhere.
- Global and project source settings merge per field, so a display override
  preserves inherited command restrictions. Explicit project source settings
  may relax global restrictions.
- Settings validation ignores invalid values and unknown keys with diagnostics
  that do not expose configuration values. Shared calls now use `extension`
  policy rather than `userInput`; migrate shared-call restrictions accordingly.
- Completed faux-provider SDK tests, saved-transcript checks, and a packed
  print-mode CLI smoke test replace the abort-before-provider workaround.
- Opted-in commands in expanded prompt templates execute without rerunning
  commands already captured from typed input. System command output stays inert and is
  retained across turns without re-execution. Killed commands report failures
  even when the process exit code is zero.
