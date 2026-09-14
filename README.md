# pi-resolve

Pi extension that resolves `@file` and `` !`command` `` references in prompts.

- `@path/to/file` — attached as a separate context message (relative to cwd or
  `~/` for the home directory).
- `@path/to/directory/` — attaches a sorted listing of immediate entries, with
  subdirectories marked `/`. File contents are not read and listings do not recurse.
  Listings include hidden entries and are capped at 1,000 entries and 100 KB,
  with a notice showing how many entries were omitted. Empty directories are
  explicitly labeled. Directory references use the same settings as file references.
- `` !`command` `` — the command runs and its stdout is attached as a separate
  context message. Your original text is kept as-is, so you still see what you
  typed.

References inside fenced code blocks or inline code spans are ignored.

Resolution is single-level: `@file` and `` !`command` `` references that appear
inside resolved file contents or command output are **not** followed. Resolved
content is treated as inert text.

## Examples / Use cases

### 1) Dynamic context in `AGENTS.md`

```md
Before proposing changes, read:
- @README.md
- @docs/architecture.md

Current TypeScript files:
!`find src -type f \( -name '*.ts' -o -name '*.tsx' \) | sort`
```

### 2) Faster prompts by batching file refs

```md
Please review this feature using:
@package.json
@tsconfig.json
@src/index.ts
@src/lib/parser.ts
@src/lib/resolve.ts
```

### 3) Git-aware review context

```md
Review only changed files from this branch:
!`git diff --name-only origin/main...HEAD`

Patch summary:
!`git diff --stat origin/main...HEAD`
```

## Install

```bash
pi install /path/to/pi-resolve
```

Or after publishing:

```bash
pi install npm:pi-resolve
```

## What gets resolved, and when

| Source         | `@file` | `` !`cmd` `` | Notes                                                                                                               |
|----------------|:-------:|:------------:|---------------------------------------------------------------------------------------------------------------------|
| `userInput`    |   yes   |     yes      | Every turn. `@file` resolves relative to cwd.                                                                       |
| `systemPrompt` |   yes   |     yes      | First turn only.                                                                                                    |
| `skill`        |   yes   |     yes      | After `$ARGUMENTS` / `$N` substitution. `@file` is relative to the skill dir; `` !`cmd` `` runs in the project cwd. |

Extension commands bypass Pi's input hooks. Commands that make their own model
calls can opt into resolution through the `pi-resolve:resolve` shared event. The
request contains `{ version: 1, text, baseDir, mode? }`; pi-resolve sets
`request.response` to a promise containing ordered `context` strings and one
structured result for every reference. Each result identifies the file or
command, source offset, and `success`, `missing`, `oversized`, `disabled`, or
`error` status. Successful results include their formatted context. Set
`mode: "files"` to resolve files without executing commands; command references
are returned as disabled and remain literal in the source text. If pi-resolve is
not installed, `request.response` remains unset. Consumers should reject failed
file outcomes and incompatible responses, including a success without a string
`context`, rather than silently dropping requested content.

### Matcher-only consumers

`extractFileRefs` from `pi-resolve/extensions/matcher.ts` is the canonical pure
matcher. It does not load the extension, read files, or execute commands. Use it
instead of a second regex when detecting whether the shared resolver is needed.

Cockpit pins its matcher dependency to Git commit
`ad6501ef81700ee1e8d3f26468c207b7afc995af`. The repository is not published on npm;
the pinned SSH Git install requires GitHub repository access. No sibling checkout
is needed for that library import.

The pinned commit predates the shared event. Importing the matcher does not
register a resolver listener. Shared-context resolution still requires loading
the newer extension through Pi's package settings. Cockpit currently loads the
local `~/src/pi-resolve` checkout that way. If that extension is absent or too
old, contexts with file references fail explicitly; plain text and code examples
do not require it.

Files larger than 100 KB and command output larger than 100 KB are attached as
"ignored" instead of included. Resolution does not recurse: refs inside resolved
files or command output are left as literal text.

## Escaping

To leave a reference as literal text, wrap it in backticks:

- `` `@path/to/file` `` — not resolved.
- ``` `` `!`cmd` `` ``` — not resolved.

Fenced ``` code blocks also suppress resolution.

### Paths

Inside an `@file` path, `\<char>` collapses to `<char>`. The path otherwise
stops at whitespace, quotes, commas, semicolons, or brackets.

| Written                     | Resolved path             |
|-----------------------------|---------------------------|
| `@./My\ Notes.md`           | `./My Notes.md`           |
| `@~/dir\,with\,commas/x.md` | `~/dir,with,commas/x.md`  |
| `@./a\(b\).txt`             | `./a(b).txt`              |

Note: backslash escaping only works *inside* a path. `\@file.md` still
resolves — use backticks to suppress the whole reference.

### Commands

`` !`cmd` `` runs `cmd` through `sh -c`, so shell quoting applies inside
the backticks. The command itself cannot contain a backtick (the closing
`` ` `` ends it); use `$(...)` for nested substitutions or a heredoc.

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
    "userInput":    {},                       // inherits everything
    "systemPrompt": { "display": "errors" },  // only render on errors
    "skill":        { "commands": false }     // no !`cmd` expansion in skills
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

- Prompt templates currently ride on `userInput` (their text reaches
  `before_agent_start` after expansion).

## Development

```bash
npm install
npm run typecheck
npm test
pi -e .
```

Run matcher and shared-event integration checks without provider calls:

```bash
node --test tests/matcher.test.ts tests/shared-event.test.ts
```

The shared-event tests load the real extension on Pi's event bus with temporary
files and isolated settings. They check file-only command suppression, inert
imports, canonical matching, base directories, and failure outcomes. Cockpit's
`pi/tests/subagent-context.test.ts` tests the pinned matcher plus the consumer's
response validation, inheritance, and aggregate size boundary with transport
fixtures. These are separate checks, not a single cross-repository end-to-end
test.
