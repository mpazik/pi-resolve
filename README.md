# pi-resolve

Give [Pi](https://pi.dev) instant context from files and shell commands.

![Pi resolving file and command references in a prompt](.github/media/pi-resolve.png)

Pi receives the files and command output before it responds, saving the time and
token overhead of extra tool calls. Your prompt stays unchanged, with file and
command status shown in Pi's conversation UI.

## Dynamic project context

Reference source documents and generate changing details directly in your project
instructions:

- **Less maintenance:** update source documents, not copies in your instructions.
  Generate indexes instead of maintaining them by hand.
- **Less waiting:** context is ready before the agent starts, without extra read
  or shell tool calls.
- **Less token overhead:** skip the requests and tool-call exchanges needed to
  collect that context.

For example, add this to `AGENTS.md`, outside a code fence. Pi receives the current
file contents and command output on the first turn of each session:

```markdown
Architecture: @docs/architecture.md
Coding conventions: @docs/conventions.md

Available guides (excluding disabled documents):
!`for doc in docs/*.md; do [ -f "$doc" ] || continue; DOC="$doc" yq -f extract 'select(.disabled != true) | [strenv(DOC), .description] | @tsv' "$doc"; done`
```

This example requires [yq](https://github.com/mikefarah/yq) and Markdown guides
with YAML frontmatter. It lists their paths and `description` fields, excluding
those with `disabled: true`, without loading their bodies.

## Install

Requires **Pi 0.85.1 through 0.85.x**, **Node.js 26**, and a POSIX `sh` for commands.

```bash
pi install npm:pi-resolve
```

Start a new Pi session after installing.

If another extension adds references to the system prompt, load pi-resolve after
it so those references are available when resolution runs.

## Usage

Resolution is single-level: references inside imported files or command output
remain text. A command that lists filenames does not attach those files.

### Files

Use `@path/to/file` to attach a file, or several files in the same prompt:

```text
Check @src/parser.ts against @docs/style.md.
```

The name after `@` must contain a **dot or slash**, not necessarily a file
extension. `@README.md`, `@.gitignore`, and `@src/README` all work. Use
`@./LICENSE` for a root-level extensionless file. Bare words such as `@LICENSE`
and `@alice` are ignored to avoid treating mentions and tags as files.

Paths are relative to the project working directory. Absolute paths and `~/`
paths also work. Escape spaces or brackets in filenames, for example
`@./My\ Notes.md` or `@./a\(b\).txt`. Without escaping, whitespace, quotes,
commas, semicolons, and brackets end a path.

### Directories

Use `@tests/` to give Pi a listing of that directory, for example:

```text
Directory listing (immediate entries):
.gitkeep
fixtures/
parser.test.ts
```

Only entry names are included, not file contents or nested listings. Entries are
sorted, hidden entries are included, and subdirectories end in `/`. Empty
directories are labeled `(empty directory)`.

### Commands

Wrap a shell command in `` !`…` `` to attach its standard output:

```text
Review my changes: !`git diff`
```

Commands run through `sh -c` in the project working directory, before the agent
responds. The next unescaped backtick ends the expression. Escape a backtick
inside the command with a backslash; shell escapes are passed to `sh` unchanged.
Prefer `$(...)` for shell substitutions.

**Commands run with your user permissions. Only use commands and project
instructions you trust.** Output limits do not undo command effects: a command
can modify files or contact services even if its output is too large to include.

### Literal references

Inline code and fenced code blocks suppress resolution. Use double backticks to
wrap a command expression: ```` `` !`git diff` `` ````.

A leading backslash also keeps a reference literal: `\@file.md` or
`` \!`git diff` ``. Backslashes pair off: an odd run escapes the marker;
an even run does not.

### Supported inputs

| Source | Setting | Files | Commands | UI feedback |
|---|---|:---:|:---:|---|
| Direct prompts | `userInput` | Yes | Yes | All |
| Prompt templates | `template` | Yes | No | All |
| System prompt, including `AGENTS.md` | `systemPrompt` | Yes | Yes | Hidden |
| Skill commands | `skill` | Yes | No | Hidden |

These are configurable defaults. Files include directory listings.

Prompts and templates resolve each turn. System context resolves on the first
turn of the session, not continuously. Skill references resolve after argument
substitution, with file paths relative to the skill directory. Commands still run
in the project directory. References you type as arguments keep direct-prompt
settings and paths.

Other extensions must opt into the shared resolver below. Arbitrary tool inputs
and outputs are not automatically resolved.

## Settings

Settings are optional and loaded at session start:

- Global: `~/.pi/agent/pi-resolve.json` (or in Pi's configured agent directory).
- Project: `.pi/pi-resolve.json` in the working directory.

For example, enable template commands and show system-context feedback in Pi:

```json
{
  "sources": {
    "template": { "commands": true },
    "systemPrompt": { "display": "always" }
  },
  "limits": {
    "maxFileBytes": 100000,
    "maxCommandBytes": 100000,
    "maxTotalBytes": 1000000,
    "commandTimeoutMs": 10000
  }
}
```

Each entry in `sources`, or the shared `defaults` object, accepts:

| Setting | Meaning |
|---|---|
| `files` | Attach file contents and directory listings. |
| `commands` | Run command references and include their output. |
| `display` | Show file/command status rows in Pi's conversation UI: `"always"`, `"errors"` (errors and skipped items only), or `"never"`. |

UI feedback includes the path or command, line count, and any error. Hiding it
with `display` does not remove content sent to the model, including notices for
failed or oversized imports. Set both `files` and `commands` to `false` to disable
a source.

Omitted values keep the defaults shown above. Project settings override global
settings per field; source-specific settings override `defaults` from either
file. Invalid settings are ignored with a warning. Use plain JSON without
comments or trailing commas, and start a new session after changes. Project
settings are trusted: they can re-enable commands disabled in global settings.

### Limits

| Setting | Default | Applies to |
|---|---:|---|
| `maxFileBytes` | 100,000 bytes | Each file or directory listing. |
| `maxCommandBytes` | 100,000 bytes | Combined stdout/stderr for each command. |
| `maxTotalBytes` | 1,000,000 bytes | Imported context per turn or shared request, including wrappers and cached system output. |
| `commandTimeoutMs` | 10,000 ms | Execution time for each command, including shared-resolver calls. |

Byte limits are positive integers and do not cap your prompt or history.
`commandTimeoutMs` accepts integers from 1 to 2,147,483,647 milliseconds. Timed-out
commands are terminated; partial output is not attached.
Imports that exceed the total budget are omitted, not cut off. Direct input takes
priority, then system context, then templates or skills. Directory listings can
truncate at their per-file limit or 1,000 entries, with an omitted-entry count.

## Extension integration

Extension commands bypass Pi's input hooks. To resolve their references, emit
`pi-resolve:resolve` with `{ version: 1, text, baseDir, mode? }`. pi-resolve sets
`request.response` to a promise containing:

- `context`: ordered strings ready to include in the model's context.
- `references`: results with `kind`, `reference`, source offset `index`, and
  `status` (`success`, `missing`, `oversized`, `disabled`, or `error`). Successful
  results include `context`; results may also include `resolvedPath` and `reason`.

`mode` is `"all"` or `"files"`. Shared calls use `sources.extension` (files enabled,
commands disabled by default); `"files"` mode can further restrict permissions,
never enable them. The caller attaches results and owns the UI feedback.

Check that `request.response` exists before awaiting it: no response means the
resolver is unavailable. Check each result before using it, so a missing file or
failed command is reported rather than silently left out of the model's context.

## Development

Use Node.js 26. From a checkout:

```bash
npm install
npm run typecheck
npm test
pi -e .
```

Pi loads TypeScript directly; there is no build step. Tests use Pi's faux provider
and isolated directories, with no external model calls or real credentials. The
suite includes a packed CLI smoke test and command-timeout checks.

[Changelog](CHANGELOG.md) · [MIT license](LICENSE)
