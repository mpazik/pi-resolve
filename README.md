# pi-resolve

Pi extension that resolves `@file` and `` !`command` `` references in prompts.

- `@path/to/file` — attached as context (relative to cwd, the containing file,
  or `~/` for the home directory).
- `` !`command` `` — replaced inline by the command's stdout.

References inside fenced code blocks or inline code spans are ignored.

## Install

```bash
pi install /path/to/pi-resolve
```

Or after publishing:

```bash
pi install npm:pi-resolve
```

## What gets resolved, and when

| Source            | `@file` | `` !`cmd` `` | Notes                                                       |
| ----------------- | :-----: | :----------: | ----------------------------------------------------------- |
| `userInput`       |   yes   |     yes      | Every turn. `@file` resolves relative to cwd.               |
| `systemPrompt`    |   yes   |     yes      | First turn only.                                            |
| `skill`           |   yes   |     yes      | After `$ARGUMENTS` / `$N` substitution. `@file` is relative to the skill dir; `` !`cmd` `` runs in the project cwd. |
| `skillToolResult` |    —    |     yes      | Inlined in the Skill tool's text output.                    |

Imported markdown files have their `@file` refs resolved recursively up to a
depth of 5. Files larger than 100 KB and command output larger than 100 KB are
attached as "ignored" instead of inlined.

## Settings

Settings live in their own file (not pi's `settings.json`):

- Global: `~/.pi/agent/pi-resolve.json`
- Project: `<cwd>/.pi/pi-resolve.json` (overrides global)

```jsonc
{
  // applied unless overridden under sources.<name>
  "defaults": {
    "files": true,
    "commands": true,
    "display": "always"     // "always" | "never" | "errors"
  },
  "sources": {
    "userInput":       {},                       // inherits everything
    "systemPrompt":    { "display": "errors" },  // only render on errors
    "skill":           { "commands": false },    // no !`cmd` expansion in skills
    "skillToolResult": { "display": "never" }    // commands-only, no TUI row
  }
}
```

### How it resolves

For each source the effective config is `{ ...defaults, ...sources[name] }` —
a shallow override. Missing source entries inherit `defaults` unchanged.

- `files` / `commands` — toggle that kind of resolution for that source.
- `display` — when the TUI context summary should include items from this source:
  - `"always"` — every resolved item (ok, error, or skipped) appears.
  - `"errors"` — only error/skipped items appear; successful ones are silent.
  - `"never"` — items from this source never appear in the TUI. Resolution still
    happens; content is still attached to the model.

If filtering leaves no items at all, the context summary is omitted from the
TUI. Content sent to the model is independent of `display`.

### Notes

- `skillToolResult` only inlines commands; `files` is a no-op there.
- Prompt templates currently ride on `userInput` (their text reaches
  `before_agent_start` after expansion).

## Development

```bash
npm install
npm run typecheck
pi -e .
```
