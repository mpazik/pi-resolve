# pi-resolve

Attach file contents and shell-command output to your [Pi](https://pi.dev) prompts before the agent responds.

```text
Review @src/parser.ts against @docs/syntax.md.

Current changes:
!`git diff -- src/parser.ts`
```

Pi receives the files and command output alongside your prompt, without needing
to request them through tools. Your original text stays visible, with a context
summary showing what was attached.

## Dynamic project context

Reference source documents and generate changing details directly in your project
instructions:

```markdown
Architecture: @docs/architecture.md
Coding conventions: @docs/conventions.md

Current project layout:
!`git ls-files src`
```

Put this in `AGENTS.md`, outside a code fence. On the first turn of each session,
Pi receives the current contents and command output.

- **Less maintenance:** update the source documents, not copies in your
  instructions. Generate the project layout instead of maintaining it by hand.
- **Less waiting:** context is ready before the agent starts, without extra read
  or shell tool calls.
- **Less token overhead:** skip the requests and tool-call exchanges needed to
  collect that context. The imported content still uses tokens, so include what
  the agent routinely needs.

## Install

```bash
pi install npm:pi-resolve
```

Start a new Pi session after installing. Requires Node.js 26 and Pi 0.85.1
through 0.85.x. Shell commands require a POSIX `sh`.

## Usage

### Files

Use `@path` to attach a file, or several files in the same prompt:

```text
Check that @src/parser.ts follows @docs/syntax.md and @docs/style.md.
```

Paths are relative to the project working directory. Absolute paths and `~/`
paths also work. Bare names such as `@LICENSE` are ignored to avoid matching
mentions and tags; use `@./LICENSE` for extensionless files.

### Directories

Use a directory reference to attach a listing of its immediate entries:

```text
Where should a new parser test go? Here are the existing tests: @tests/
```

Listings are sorted and include hidden entries. Subdirectories are marked with
`/`, and empty directories are explicitly labeled. This does not read the files
or recurse into subdirectories. Only regular files and directory listings are
supported.

### Commands

Wrap a shell command in `` !`…` `` to attach its standard output:

```text
Summarize the changes on this branch:
!`git diff --stat origin/main...HEAD`
```

Commands run through POSIX `sh -c` in the project working directory. They execute
before the agent responds, not at the agent's discretion. Shell quoting applies
inside the backticks. The command itself cannot contain a backtick, since that
closes the expression; use `$(...)` for nested substitutions or a heredoc.

**Commands run with your user permissions. Only use commands and project
instructions you trust.**

### Sources and timing

These are the defaults; each source can be configured separately.

| Source | Setting | Files and directories | Commands | Display |
|---|---|:---:|:---:|---|
| Direct prompts | `userInput` | Yes | Yes | `always` |
| Prompt templates | `template` | Yes | No | `always` |
| System prompt, including `AGENTS.md` | `systemPrompt` | Yes | Yes | `never` |
| Skill commands | `skill` | Yes | No | `never` |

Direct prompts and templates resolve each turn. System-prompt references resolve
on the first turn of the session. They are a snapshot, not a live view of changes
made during the conversation. Successful system-command output is inserted into
the system prompt and reapplied on later turns without rerunning the command.

Skills resolve after argument substitution. File paths authored in a skill are
relative to its directory; shell commands still run in the project working
directory. References supplied as arguments retain direct-input policy through
expansion, including repeated substitutions, and direct-input file paths use the
project working directory. Without an expansion source map, an identical
reference authored in a template is also treated as direct input.

Pi runs extension hooks in load order. To resolve system-prompt references added
by another extension, pi-resolve must run after it on the first turn. It does not
enforce last position; filename prefixes such as `z-` do not guarantee load order.

Extension commands can opt in through the shared resolver described below.
Arbitrary tool inputs and outputs are not automatically resolved.

## Configuration

Settings live in their own file, not Pi's `settings.json`:

- Global: `~/.pi/agent/pi-resolve.json`, or `pi-resolve.json` in Pi's configured
  agent directory.
- Project: `<cwd>/.pi/pi-resolve.json`.

No configuration is needed to start. Settings are loaded at session start; start
a new session after changing them. The file must contain JSON, without comments
or trailing commas. Omit fields to keep their defaults.

For example, enable commands authored in prompt templates and show system-context
summaries:

```json
{
  "sources": {
    "template": { "commands": true },
    "systemPrompt": { "display": "always" }
  },
  "limits": {
    "maxFileBytes": 100000,
    "maxCommandBytes": 100000,
    "maxTotalBytes": 1000000
  }
}
```

### Source controls

`defaults` and each entry in `sources` accept:

| Field | Meaning |
|---|---|
| `files` | Enable file contents and directory listings. |
| `commands` | Enable shell-command execution. |
| `display` | Choose which results appear in the context summary. |

Set both `files` and `commands` to `false` to disable resolution for a source.
The built-in defaults are `files: true`, `commands: true`, and `display: "always"`,
with the source overrides shown in the table above. Shared API calls use the
additional `extension` source, with files enabled and commands disabled by default.

Display values:

- `"always"`: show every resolved item, including errors and skipped items.
- `"errors"`: show only errors and skipped items.
- `"never"`: do not show items from this source.

The summary shows labels, line counts, and errors. If filtering leaves no items,
the summary is omitted. Display does not control content sent to the model.

### Precedence and validation

Settings merge per field, in this order from lowest to highest priority:

1. Built-in policy for the source.
2. Global `defaults`.
3. Project `defaults`.
4. Global `sources.<source>`.
5. Project `sources.<source>`.

Missing fields inherit. Source-specific settings are more specific than defaults,
including project defaults. For example, global `sources.skill.commands: false`
remains disabled when a project only sets `sources.skill.display: "never"`.

Limits also merge per field, with project values overriding global values.

Invalid JSON or unreadable settings files are ignored with a warning. Invalid
object shapes, field types, display values, and unknown keys are warned about
and ignored; valid fields still apply. Diagnostics do not include setting values.

### Limits

All limits are positive integer byte counts.

| Setting | Default | Applies to |
|---|---:|---|
| `maxFileBytes` | 100,000 | Each file or directory listing. |
| `maxCommandBytes` | 100,000 | Combined stdout/stderr capture for each command. |
| `maxTotalBytes` | 1,000,000 | Successful imported context per turn or shared request. |

Directory listings also have a 1,000-entry cap. Truncated listings include a
notice showing how many entries were omitted.

The total budget includes attachment wrappers and system-command output. Cached
system output counts when reapplied; historical attachments do not count again.
The original prompt and conversation history are not capped. Failure notices
remain available even when the budget is exhausted.

References use the budget in this order: direct input, system context, then
expanded templates or skills. Within each source, source-text order wins. A
reference that does not fit is omitted rather than silently cut off. Directory
listings can truncate at their per-file limit; the total limit never further
shortens a listing.

## Behavior and safety

### Escaping

Inline code spans and fenced code blocks suppress resolution. To write a literal
file reference, wrap it in backticks. For a command expression that already
contains backticks, use a double-backtick code span:

````markdown
`@path/to/file.md`
`` !`git status` ``
````

Inside a path, `\<char>` collapses to `<char>`. Otherwise, a path stops at
whitespace, quotes, commas, semicolons, or brackets.

| Written | Resolved path |
|---|---|
| `@./My\ Notes.md` | `./My Notes.md` |
| `@~/dir\,with\,commas/x.md` | `~/dir,with,commas/x.md` |
| `@./a\(b\).txt` | `./a(b).txt` |

Backslash escaping only works inside a path. `\@file.md` still resolves.

### Imported content and failures

Resolution is single-level. References inside imported files or command output
remain text. A command that lists filenames does not attach those files.

Failed or oversized references produce explicit failure notices for the model
instead of content, regardless of display settings.

### Command execution

Commands time out after ten seconds. Background processes in their POSIX process
group are terminated when the shell exits.

System prompts, `AGENTS.md`, and project settings are trusted configuration.
Project settings can enable commands disabled by global settings. `AGENTS.md`
shares the `systemPrompt` policy, which enables commands by default.

Limits are not a sandbox. A command may already have run before its output is
rejected.

## Extension integration

Extension commands bypass Pi's input hooks. Commands that make their own model
calls can opt into resolution through the `pi-resolve:resolve` shared event.

### Shared resolver

The request contains:

| Field | Value |
|---|---|
| `version` | `1` |
| `text` | Text containing references to resolve. |
| `baseDir` | Base directory for file paths and command execution. |
| `mode` | Optional: `"all"` or `"files"`. |

pi-resolve sets `request.response` to a promise containing:

- `context`: ordered strings of resolved context.
- `references`: one structured result for every reference.

Each result has `kind` (`"file"` or `"command"`), `reference`, the source offset
`index`, and a `status`: `"success"`, `"missing"`, `"oversized"`, `"disabled"`, or
`"error"`. Results can also include `resolvedPath`, `context`, and `reason`.
Successful results include their formatted `context`.

With `mode: "files"`, commands are not executed. Command references are returned
as disabled and remain literal in the source text.

If pi-resolve is not installed, `request.response` remains unset. Consumers must
handle an unset response and reject failed file outcomes or incompatible
responses, including a success without a string `context`, rather than silently
dropping requested content.

### Policy and ownership

Shared calls use `sources.extension`, which inherits defaults, not
`sources.userInput`. Restrictions for shared calls belong under `extension`.

Caller restrictions can only reduce capabilities: `mode: "files"` never executes
commands and cannot enable files disabled by settings. Shared calls use the same
size limits, with a separate total budget for each request.

Shared calls return structured results without automatically attaching them or
rendering a summary. The calling extension or tool owns those actions;
`extension.display` does not cause automatic rendering.

### Matcher-only consumers

`extractFileRefs` from `pi-resolve/src/matcher.ts` is the canonical pure matcher.
It does not load the extension, read files, or execute commands. Consumers can
use it to detect whether the shared resolver is needed without maintaining a
second regular expression.

Importing the matcher does not register a resolver listener. Load the extension
through Pi's package settings to use the shared event. Consumers must still
handle an unset `request.response` when the extension is absent or incompatible.

## Development

Use Node.js 26. From a checkout:

```bash
npm install
npm run typecheck
npm test
pi -e .
```

To install the checkout for regular use:

```bash
pi install /path/to/pi-resolve
```

Pi loads TypeScript directly from `src/` through the package manifest. There is
no build step or `dist/` directory. Tests and reusable fixtures live separately
in `tests/` and are excluded from the published package.

Tests use Pi's built-in faux provider and isolated scratch directories, with no
external model calls or real credentials. The suite includes a packed CLI smoke
test and real command-timeout checks. Run a focused suite with
`node --test tests/resolver.test.ts`.

[Changelog](CHANGELOG.md) · [MIT license](LICENSE)
