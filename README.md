# pi-resolve

Give [Pi](https://pi.dev) instant context from files and shell commands.

![Pi resolving file and command references in a prompt](https://github.com/user-attachments/assets/865feaec-1b02-4c9a-a5e4-477c1bb0142a)

Pi receives the files and command output before the agent responds, saving the time and
token overhead of extra tool calls. Your prompt stays unchanged, with file and
command status shown in Pi's UI.

## Dynamic project context

With pi-resolve, `AGENTS.md` can reference source documents and generate context
with shell commands.

- **Less maintenance:** update source documents, not copies in your instructions.
  Generate indexes instead of maintaining them by hand.
- **Less waiting:** context is ready before the agent starts, without extra read
  or shell tool calls.
- **Less token overhead:** skip the requests and tool-call exchanges needed to
  collect that context.

```markdown
Architecture: @docs/architecture.md
Coding conventions: @docs/conventions.md

Active guides:
!`find docs -type f -name '*.md' -exec env DOC={} \
  yq -f extract \
  'select(.status == "active") | [strenv(DOC), .description] | @tsv' {} \;`
```

Here, Pi receives the contents of the architecture and conventions files and a
guide index that includes only paths and descriptions for active guides
(requires [yq](https://github.com/mikefarah/yq)).

References also work in **skills and prompt templates**. Other extensions can opt
in through the [shared resolver](#extension-integration).

## Install

```bash
pi install npm:pi-resolve
```

Start a new Pi session after installing.

Requires the latest stable Pi and **Node.js 22.19.0 or newer**, matching Pi's
runtime requirement. Supports **macOS and Linux** with `sh` available.
Native Windows is not tested; use Linux under WSL.

## Usage

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

**Commands run with your user permissions.** Only use commands and project
instructions you trust. Output limits do not undo command effects: a command
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

Skill references resolve after argument substitution, with file paths relative
to the skill directory. Commands still run
in the project directory. References you type as arguments keep direct-prompt
settings and paths.

Other extensions must opt into the shared resolver below. Prompts injected with
`pi.sendUserMessage`, including their expanded templates and skills, are not
automatically resolved. Arbitrary tool inputs and outputs are also left untouched.

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

`display` only controls UI feedback. To disable a source, set both `files` and
`commands` to `false`.

Unspecified values keep their defaults. Project settings override global settings
per field; source settings override `defaults`. Only use trusted project settings:
they can re-enable commands. Use plain JSON and restart the session after changes.

### Limits

| Setting | Default | Applies to |
|---|---:|---|
| `maxFileBytes` | 100,000 bytes | Each file or directory listing. |
| `maxCommandBytes` | 100,000 bytes | Combined stdout/stderr for each command. |
| `maxTotalBytes` | 1,000,000 bytes | Imported context per turn or shared request. |
| `commandTimeoutMs` | 10,000 ms | Each command. |

Over-budget imports are skipped; directory listings may be shortened. Timed-out
commands are stopped and their output discarded. These limits do not cap your
prompt or history.

## Extension integration

Emit `pi-resolve:resolve` with `{ version: 1, text, baseDir, mode? }`, then await
`request.response` if present. The response contains `context` strings to attach
and `references` with per-item status. The caller handles attachment and UI,
including failures. No response means pi-resolve is unavailable.

Shared calls use `sources.extension`: files enabled, commands disabled by default.
`mode` accepts `"all"` or `"files"`; it cannot enable disabled commands. Commands
run in `baseDir`.

## Caveats

- Queued steering and follow-up prompts do not receive resolved context, but
  their commands may still run. Wait until the agent finishes to submit references.
- Imports are single-level: references inside files or command output stay literal.
- System references resolve once after session start or reload, not every turn.
- Commands may run concurrently. Put dependent steps in one expression.
- System references added by other extensions depend on hook order. Use the
  shared resolver for explicit integration.

## Development

Use Node.js 26 for development. From a checkout:

```bash
npm install
npm run typecheck
npm test
pi -e .
```

No build step or model credentials are needed.

[Changelog](CHANGELOG.md) · [MIT license](LICENSE)
