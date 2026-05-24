/**
 * pi-resolve
 *
 * Resolves @file and !`command` references in user input, system prompt,
 * skill content, and Skill tool results.
 *
 * Syntax:
 *   @path/to/file.md  — attach file contents as context (relative to cwd or containing file)
 *   @~/path/to/file    — attach file from home directory
 *   !`command`         — inline command output (replaces the reference in text)
 *
 * References inside fenced code blocks or inline code spans are ignored.
 *
 * Behavior:
 *   - !`command`: inlined into text (replaces the reference with output)
 *   - @file: attached as separate context alongside the text
 *   - @file refs in imported files are resolved recursively (max depth 5)
 *   - Nested @file paths resolve relative to the containing file's directory
 *   - User input: resolved every turn
 *   - System prompt / AGENTS.md: resolved first turn only
 *   - Skills: !`command` and @file resolved after expansion, with $ARGUMENTS
 *     substitution and skill baseDir as cwd
 *   - Skill tool results: !`command` resolved via tool_result hook
 *   - Errors: attached with error marker, shown as warnings in TUI
 *
 * Settings:
 *   Read from `~/.pi/agent/pi-resolve.json` (global) and
 *   `<cwd>/.pi/pi-resolve.json` (project, overrides global).
 *
 *   {
 *     "defaults": { "files": true, "commands": true, "display": "always" },
 *     "sources": {
 *       "userInput":       {},
 *       "systemPrompt":    { "display": "errors" },
 *       "skill":           { "commands": false },
 *       "skillToolResult": { "display": "never" }
 *     }
 *   }
 *
 *   `display` is one of "always" | "never" | "errors". Effective source config
 *   is `{ ...defaults, ...sources[name] }` (shallow override).
 */

import { existsSync, readFileSync } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { isAbsolute, join, dirname } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";

// ---------- regex patterns ----------

/** Matches `@relative/path` but not inside backticks, preceded by word chars, `/` (npm scopes), or quotes (imports).
 *  Supports backslash-escaped characters (e.g., `\ ` for spaces in paths).
 *  Also matches `@~/...` for home directory references.
 *  Excludes quotes, semicolons, and brackets from path characters to avoid matching
 *  import statements, parenthesized expressions, and markdown link syntax. */
const FILE_REGEX =
  /(?<![\w`/"'])@(~\/(?:[^\s`,.\\"';()[\]{}]|\\.)*(?:\.(?:[^\s`,.\\"';()[\]{}]|\\.)+)*|\.?(?:[^\s`,.\\"';()[\]{}]|\\.)*(?:\.(?:[^\s`,.\\"';()[\]{}]|\\.)+)*)/g;

/** Matches `` !`command` `` but not when `!` is preceded by a backtick (e.g., inline code `!`) */
const SHELL_REGEX = /(?<!`)!`([^`]+)`/g;

/** Matches a <skill> block with optional trailing arguments */
const SKILL_BLOCK_REGEX =
  /^<skill name="([^"]+)" location="([^"]+)">\nReferences are relative to ([^\n]+)\.\n\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

// ---------- settings ----------

type Source = "userInput" | "systemPrompt" | "skill" | "skillToolResult";
type Display = "always" | "never" | "errors";

interface SourceConfig {
  files: boolean;
  commands: boolean;
  display: Display;
}

interface Settings {
  defaults: SourceConfig;
  sources: Partial<Record<Source, Partial<SourceConfig>>>;
}

const DEFAULT_SETTINGS: Settings = {
  defaults: { files: true, commands: true, display: "always" },
  sources: {},
};

function readJsonIfExists(path: string): any {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    console.error(`[pi-resolve] Failed to read ${path}: ${err}`);
    return undefined;
  }
}

function loadSettings(cwd: string): Settings {
  const global = readJsonIfExists(join(getAgentDir(), "pi-resolve.json")) ?? {};
  const project = readJsonIfExists(join(cwd, ".pi", "pi-resolve.json")) ?? {};
  return {
    defaults: {
      ...DEFAULT_SETTINGS.defaults,
      ...(global.defaults ?? {}),
      ...(project.defaults ?? {}),
    },
    sources: { ...(global.sources ?? {}), ...(project.sources ?? {}) },
  };
}

function cfgFor(settings: Settings, src: Source): SourceConfig {
  return { ...settings.defaults, ...(settings.sources[src] ?? {}) };
}

// ---------- types ----------

interface FileAttachment {
  kind: "file";
  source: Source;
  resolvedPath: string;
  displayPath: string;
  content: string;
  error?: string;
  skipped?: boolean;
}

interface BashInline {
  kind: "bash";
  source: Source;
  command: string;
  output: string;
  error?: string;
  skipped?: boolean;
}

interface SkillBlock {
  name: string;
  location: string;
  baseDir: string;
  body: string;
  args: string;
}

// ---------- constants ----------

const MAX_FILE_BYTES = 100_000;
const MAX_BASH_BYTES = 100_000;
const MAX_IMPORT_DEPTH = 5;

// ---------- code ranges ----------

/** Build a set of character ranges that fall inside fenced code blocks or inline code spans.
 *  Used to check whether a regex match at a given offset should be skipped. */
function buildCodeRanges(text: string): Array<[start: number, end: number]> {
  const ranges: Array<[number, number]> = [];
  for (const m of text.matchAll(/^```[\s\S]*?^```/gm)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  for (const m of text.matchAll(/!`[^`]+`|``[^`]*``|`[^`]*`/g)) {
    if (m[0][0] !== "!") {
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
  return ranges;
}

/** Check if a character offset falls inside any code range. */
function isInsideCode(
  offset: number,
  ranges: Array<[number, number]>,
): boolean {
  for (const [start, end] of ranges) {
    if (offset >= start && offset < end) return true;
  }
  return false;
}

// ---------- path resolution ----------

function expandHome(filepath: string): string {
  if (filepath.startsWith("~/")) {
    return join(homedir(), filepath.slice(2));
  }
  return filepath;
}

function resolvePath(name: string, baseDir: string): string {
  const expanded = expandHome(name);
  return isAbsolute(expanded) ? expanded : join(baseDir, expanded);
}

// ---------- skill parsing ----------

/** Parse a <skill> block from prompt text. Returns null if not a skill prompt. */
function parseSkillBlock(text: string): SkillBlock | null {
  const match = text.match(SKILL_BLOCK_REGEX);
  if (!match) return null;
  return {
    name: match[1]!,
    location: match[2]!,
    baseDir: match[3]!,
    body: match[4]!,
    args: match[5]?.trim() ?? "",
  };
}

/** Substitute $ARGUMENTS, $ARGUMENTS[N], and $N placeholders in skill body.
 *  Matches Claude Code skill variable substitution behavior. */
function substituteSkillArgs(body: string, args: string): string {
  const argList = args ? args.split(/\s+/) : [];

  let result = body;

  // $ARGUMENTS[N] and $ARGUMENTS — must replace indexed forms first
  result = result.replace(
    /\$ARGUMENTS\[(\d+)]/g,
    (_m, idx) => argList[parseInt(idx)] ?? "",
  );
  result = result.replace(/\$ARGUMENTS/g, args);

  // $N shorthand (only if not preceded by { which would be ${N:-...} shell syntax)
  // We need to be careful: $0 in shell means something different.
  // Replace $N that are pi skill arguments, but preserve ${...} shell expressions.
  result = result.replace(
    /\$(\d+)(?![}\w])/g,
    (_m, idx) => argList[parseInt(idx)] ?? "",
  );

  return result;
}

// ---------- bash inlining ----------

/** Inline all !`command` references in text, replacing them with their output.
 *  Only processes refs that appear outside code blocks/spans. */
async function inlineBashRefs(
  text: string,
  cwd: string,
  pi: ExtensionAPI,
  source: Source,
): Promise<{ text: string; inlines: BashInline[] }> {
  const codeRanges = buildCodeRanges(text);

  // Collect all matches outside code ranges
  const matches: Array<{ index: number; fullMatch: string; cmd: string }> = [];
  for (const m of text.matchAll(SHELL_REGEX)) {
    if (!isInsideCode(m.index, codeRanges)) {
      matches.push({ index: m.index, fullMatch: m[0], cmd: m[1]! });
    }
  }
  if (matches.length === 0) return { text, inlines: [] };

  // Execute all commands in parallel
  const [results] = await Promise.all([
    Promise.all(
      matches.map(async ({ cmd, fullMatch }) => {
        try {
          const result = await pi.exec("sh", ["-c", cmd], {
            cwd,
            timeout: 10_000,
          });
          const stdout = result.stdout.trimEnd();

          if (stdout.length > MAX_BASH_BYTES) {
            return {
              cmd,
              fullMatch,
              inline: {
                kind: "bash" as const,
                source,
                command: cmd,
                output: "",
                skipped: true,
              },
              replacement: fullMatch,
            };
          }

          if (result.code !== 0) {
            // eslint-disable-next-line no-control-regex
            const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
            const output = stripAnsi(
              result.stderr.trim() || result.stdout.trim(),
            ).slice(0, 500);
            const detail = output || `exit code ${result.code}`;
            console.error(`[pi-resolve] Shell error (${cmd}): ${detail}`);
            return {
              cmd,
              fullMatch,
              inline: {
                kind: "bash" as const,
                source,
                command: cmd,
                output: "",
                error: detail,
              },
              replacement: fullMatch,
            };
          }

          return {
            cmd,
            fullMatch,
            inline: {
              kind: "bash" as const,
              source,
              command: cmd,
              output: stdout,
            },
            replacement: stdout,
          };
        } catch (err: any) {
          const detail = err instanceof Error ? err.message : String(err);
          console.error(`[pi-resolve] Shell error (${cmd}): ${detail}`);
          return {
            cmd,
            fullMatch,
            inline: {
              kind: "bash" as const,
              source,
              command: cmd,
              output: "",
              error: detail,
            },
            replacement: fullMatch,
          };
        }
      }),
    ),
  ]);

  // Replace in reverse offset order to preserve indices
  const inlines: BashInline[] = [];
  let result = text;
  for (let i = results.length - 1; i >= 0; i--) {
    const r = results[i]!;
    const m = matches[i]!;
    inlines.unshift(r.inline);
    result =
      result.slice(0, m.index) +
      r.replacement +
      result.slice(m.index + m.fullMatch.length);
  }

  return { text: result, inlines };
}

// ---------- file resolution ----------

/** Resolve @file references in text, returning attachments.
 *  Recursively resolves @file refs found in imported files up to maxDepth.
 *  Nested refs resolve relative to the containing file's directory. */
async function resolveFileRefs(
  text: string,
  baseDir: string,
  visited: Set<string>,
  depth: number,
  source: Source,
): Promise<FileAttachment[]> {
  const codeRanges = buildCodeRanges(text);
  const matches = Array.from(text.matchAll(FILE_REGEX)).filter(
    (m) => !isInsideCode(m.index, codeRanges),
  );
  if (matches.length === 0) return [];

  const attachments: FileAttachment[] = [];
  for (const match of matches) {
    const name = match[1]!.replace(/\\(.)/g, "$1");

    // Skip bare words without `/` or `.` — these are decorators, JSDoc tags,
    // CSS @rules, mentions, etc. Use `@./Makefile` for extensionless files.
    if (!name.includes("/") && !name.includes(".")) continue;

    const filepath = resolvePath(name, baseDir);

    if (visited.has(filepath)) continue;

    try {
      const stats = await stat(filepath);
      if (stats.isDirectory()) continue;
      if (stats.size > MAX_FILE_BYTES) {
        attachments.push({
          kind: "file",
          source,
          resolvedPath: filepath,
          displayPath: name,
          content: "",
          skipped: true,
        });
        continue;
      }
      const content = await readFile(filepath, "utf-8");
      attachments.push({
        kind: "file",
        source,
        resolvedPath: filepath,
        displayPath: name,
        content,
      });

      if (depth < MAX_IMPORT_DEPTH && filepath.endsWith(".md")) {
        visited.add(filepath);
        const nestedDir = dirname(filepath);
        const nested = await resolveFileRefs(
          content,
          nestedDir,
          visited,
          depth + 1,
          source,
        );
        attachments.push(...nested);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      attachments.push({
        kind: "file",
        source,
        resolvedPath: filepath,
        displayPath: name,
        content: "",
        error: errMsg,
      });
    }
  }
  return attachments;
}

// ---------- dedup & format ----------

function dedup(attachments: FileAttachment[]): FileAttachment[] {
  const seen = new Set<string>();
  return attachments.filter((a) => {
    if (seen.has(a.resolvedPath)) return false;
    seen.add(a.resolvedPath);
    return true;
  });
}

function formatAttachment(a: FileAttachment): string {
  if (a.error) return `<file path="${a.displayPath}" error="${a.error}" />`;
  return `<file path="${a.displayPath}">\n${a.content}\n</file>`;
}

// ---------- display ----------

interface AttachmentLine {
  kind: "file" | "bash";
  label: string;
  lines: number;
  result: "ok" | "error" | "skipped";
  message?: string;
}

interface ContextDetails {
  items: AttachmentLine[];
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

/** True if the item should be displayed under its source's display mode. */
function shouldDisplay(display: Display, result: "ok" | "error" | "skipped") {
  if (display === "never") return false;
  if (display === "errors") return result !== "ok";
  return true;
}

function buildDetails(
  attachments: FileAttachment[],
  inlines: BashInline[],
  settings: Settings,
): ContextDetails {
  const items: AttachmentLine[] = [];

  for (const b of inlines) {
    const result = b.skipped ? "skipped" : b.error ? "error" : "ok";
    if (!shouldDisplay(cfgFor(settings, b.source).display, result)) continue;
    items.push({
      kind: "bash",
      label: b.command,
      lines: result === "ok" ? countLines(b.output) : 0,
      result,
      message:
        result === "skipped" ? "too large" : result === "error" ? b.error : undefined,
    });
  }

  for (const a of attachments) {
    const result = a.skipped ? "skipped" : a.error ? "error" : "ok";
    if (!shouldDisplay(cfgFor(settings, a.source).display, result)) continue;
    items.push({
      kind: "file",
      label: a.displayPath,
      lines: result === "ok" ? countLines(a.content) : 0,
      result,
      message:
        result === "skipped" ? "too large" : result === "error" ? a.error : undefined,
    });
  }

  return { items };
}

// ---------- extension hook ----------

export default function (pi: ExtensionAPI) {
  let sessionCwd: string = process.cwd();
  let systemContextInjected = false;
  let settings: Settings = DEFAULT_SETTINGS;

  // Bash inlines from input event — display only (already inlined into text)
  let pendingDisplayInlines: BashInline[] = [];

  pi.registerMessageRenderer<ContextDetails>(
    "context",
    (message, _options, theme) => {
      const items = message.details?.items ?? [];
      if (items.length === 0) return undefined;
      const container = new Container();
      container.addChild(new Spacer(1));
      for (const item of items) {
        const badge =
          item.kind === "file"
            ? theme.inverse(theme.fg("accent", " file "))
            : theme.inverse(theme.fg("bashMode", " bash "));
        const label = theme.fg("dim", ` ${item.label}`);
        let meta: string;
        if (item.result === "ok") {
          meta = theme.fg(
            "dim",
            ` (${item.lines} line${item.lines !== 1 ? "s" : ""})`,
          );
        } else {
          const statusBadge =
            item.result === "skipped" ? " ignored " : " error ";
          meta = " " + theme.inverse(theme.fg("warning", statusBadge));
          if (item.message) meta += theme.fg("dim", ` — ${item.message}`);
        }
        container.addChild(new Text(badge + label + meta, 0, 0));
      }
      return container;
    },
  );

  pi.on("session_start", async (_event, ctx) => {
    sessionCwd = ctx.cwd;
    systemContextInjected = false;
    settings = loadSettings(sessionCwd);
  });

  // Inline !`command` in user input (before skill expansion)
  pi.on("input", async (event) => {
    if (!cfgFor(settings, "userInput").commands) return { action: "continue" };
    const { text, inlines } = await inlineBashRefs(
      event.text,
      sessionCwd,
      pi,
      "userInput",
    );
    if (inlines.length > 0) {
      pendingDisplayInlines = inlines;
      return { action: "transform", text };
    }
    return { action: "continue" };
  });

  // Resolve !`command` in Skill tool results (skill-tool extension returns
  // raw content with unresolved refs; we intercept and inline them here)
  pi.on("tool_result", async (event) => {
    if (event.toolName !== "Skill" || event.isError) return;
    if (!cfgFor(settings, "skillToolResult").commands) return;

    const textParts = event.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );
    if (textParts.length === 0) return;

    let changed = false;
    const newContent = await Promise.all(
      event.content.map(async (part) => {
        if (part.type !== "text") return part;
        const { text: resolved, inlines } = await inlineBashRefs(
          part.text,
          sessionCwd,
          pi,
          "skillToolResult",
        );
        if (inlines.length > 0) changed = true;
        return { type: "text" as const, text: resolved };
      }),
    );

    if (changed) {
      return { content: newContent };
    }
  });

  pi.on("before_agent_start", async (event) => {
    const allAttachments: FileAttachment[] = [];
    // Display-only: already inlined via input event, just need TUI display
    const displayOnlyInlines: BashInline[] = [...pendingDisplayInlines];
    pendingDisplayInlines = [];
    // Context inlines: from skills/system prompt, need to be attached as context
    const contextInlines: BashInline[] = [];
    let modifiedSystemPrompt: string | undefined;

    // --- System prompt — first turn only ---
    if (!systemContextInjected) {
      const sysCfg = cfgFor(settings, "systemPrompt");
      let inlinedSystem = event.systemPrompt;
      let systemInlines: BashInline[] = [];

      if (sysCfg.commands) {
        const r = await inlineBashRefs(
          event.systemPrompt,
          sessionCwd,
          pi,
          "systemPrompt",
        );
        inlinedSystem = r.text;
        systemInlines = r.inlines;
        // System prompt inlines are inlined into the prompt itself, display only
        displayOnlyInlines.push(...systemInlines);
      }

      const systemFileRefs = sysCfg.files
        ? await resolveFileRefs(
            inlinedSystem,
            sessionCwd,
            new Set<string>(),
            0,
            "systemPrompt",
          )
        : [];

      if (systemFileRefs.length > 0 || systemInlines.length > 0) {
        allAttachments.push(...systemFileRefs);
        modifiedSystemPrompt = inlinedSystem;
      }
      systemContextInjected = true;
    }

    // --- User input / skill content — every turn ---
    const prompt = event.prompt;
    const skill = parseSkillBlock(prompt);

    if (skill) {
      const skillCfg = cfgFor(settings, "skill");
      // Skill prompt: substitute $ARGUMENTS/$N, then resolve refs
      const substituted = substituteSkillArgs(skill.body, skill.args);

      if (skillCfg.commands) {
        // !`command` runs from session cwd (project root), not the skill directory
        const { inlines: skillInlines } = await inlineBashRefs(
          substituted,
          sessionCwd,
          pi,
          "skill",
        );
        // Can't modify prompt text post-expansion, attach as context
        contextInlines.push(...skillInlines);
      }

      if (skillCfg.files) {
        // @file refs resolve relative to skill baseDir (file references within the skill)
        const visited = new Set<string>();
        const skillFileRefs = await resolveFileRefs(
          substituted,
          skill.baseDir,
          visited,
          0,
          "skill",
        );
        allAttachments.push(...skillFileRefs);

        // Also resolve @file refs in trailing arguments (relative to session cwd)
        if (skill.args) {
          const argsFileRefs = await resolveFileRefs(
            skill.args,
            sessionCwd,
            visited,
            0,
            "skill",
          );
          allAttachments.push(...argsFileRefs);
        }
      }
    } else if (cfgFor(settings, "userInput").files) {
      // Regular user input: !`command` was already inlined via input event,
      // just resolve @file refs
      const inputFileRefs = await resolveFileRefs(
        prompt,
        sessionCwd,
        new Set<string>(),
        0,
        "userInput",
      );
      allAttachments.push(...inputFileRefs);
    }

    const dedupedAttachments = dedup(allAttachments);
    const allDisplayInlines = [...displayOnlyInlines, ...contextInlines];
    const hasContent =
      dedupedAttachments.length > 0 ||
      contextInlines.length > 0 ||
      allDisplayInlines.length > 0;

    if (!hasContent && !modifiedSystemPrompt) return;

    const result: {
      message?: {
        customType: string;
        content: { type: "text"; text: string }[];
        display: boolean;
        details: ContextDetails;
      };
      systemPrompt?: string;
    } = {};

    if (modifiedSystemPrompt) {
      result.systemPrompt = modifiedSystemPrompt;
    }

    if (hasContent) {
      const content: { type: "text"; text: string }[] = [];

      // Only context inlines (from skills) go into message content —
      // display-only inlines (from input/system prompt) are already inlined in their text
      for (const b of contextInlines) {
        if (!b.skipped && !b.error) {
          content.push({
            type: "text",
            text: `<bash command="${b.command}">\n${b.output}\n</bash>`,
          });
        }
      }

      for (const a of dedupedAttachments) {
        if (!a.skipped && !a.error) {
          content.push({ type: "text", text: formatAttachment(a) });
        }
      }

      result.message = {
        customType: "context",
        content,
        display: true,
        details: buildDetails(dedupedAttachments, allDisplayInlines, settings),
      };
    }

    return result;
  });
}
