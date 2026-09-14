/**
 * pi-resolve
 *
 * Resolves @file and !`command` references in user input, system prompt,
 * and skill content.
 *
 * Syntax:
 *   @path/to/file.md  — attach file contents as context (relative to cwd or containing file)
 *   @~/path/to/file    — attach file from home directory
 *   !`command`         — inline command output (replaces the reference in text)
 *
 * References inside fenced code blocks or inline code spans are ignored.
 *
 * Behavior:
 *   - @file and !`command`: both attached as separate context alongside the
 *     text. The original text is kept as-is (user sees what they typed).
 *   - Resolution is single-level: @file refs and !`command` refs inside
 *     resolved file contents or command output are NOT followed. Resolved
 *     content is treated as inert text.
 *   - User input: resolved every turn
 *   - System prompt / AGENTS.md: resolved first turn only (commands inlined
 *     into the prompt text itself, display only)
 *   - Skills: !`command` and @file resolved after expansion, with $ARGUMENTS
 *     substitution and skill baseDir as cwd
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
 *       "skill":           { "commands": false }
 *     }
 *   }
 *
 *   `display` is one of "always" | "never" | "errors". Effective source config
 *   is `{ ...defaults, ...sources[name] }` (shallow override).
 */

import { existsSync, readFileSync } from "node:fs";
import { stat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  Container,
  getCapabilities,
  hyperlink,
  Loader,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import {
  SKILL_BLOCK_REGEX,
  extractFileRefs,
  extractFileReferenceMatches,
  extractCommandRefs,
} from "./matcher.ts";

// ---------- settings ----------

type Source = "userInput" | "systemPrompt" | "skill";
type Display = "always" | "never" | "errors";

export const RESOLVE_REFERENCES_EVENT = "pi-resolve:resolve";

export type ReferenceResolutionStatus =
  "success" | "missing" | "oversized" | "disabled" | "error";

export interface ReferenceResolution {
  kind: "file" | "command";
  reference: string;
  index: number;
  status: ReferenceResolutionStatus;
  resolvedPath?: string;
  context?: string;
  reason?: string;
}

export interface ResolveReferencesResult {
  context: string[];
  references: ReferenceResolution[];
}

export interface ResolveReferencesRequest {
  version: 1;
  text: string;
  baseDir: string;
  mode?: "all" | "files";
  response?: Promise<ResolveReferencesResult>;
}

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
  errorCode?: string;
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
const MAX_DIRECTORY_ENTRIES = 1_000;
const MAX_BASH_BYTES = 100_000;

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
  const matches = extractCommandRefs(text);
  if (matches.length === 0) return { text, inlines: [] };

  // Execute all commands in parallel
  const [results] = await Promise.all([
    Promise.all(
      matches.map(async ({ command: cmd, fullMatch }) => {
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

async function listDirectory(filepath: string): Promise<string> {
  const entries = await readdir(filepath, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (entries.length === 0) return "Directory listing (immediate entries):\n(empty directory)";

  const lines = ["Directory listing (immediate entries):"];
  const truncationNotice = (omitted: number) =>
    `[truncated: ${omitted} entries omitted]`;
  let bytes = Buffer.byteLength(lines[0]!, "utf8");
  const reservedBytes = Buffer.byteLength(truncationNotice(entries.length), "utf8") + 1;
  let included = 0;
  for (const entry of entries) {
    // Keep unusual filenames on one line without interpreting their contents.
    const name = /[\r\n\t]/.test(entry.name) ? JSON.stringify(entry.name) : entry.name;
    const line = `${name}${entry.isDirectory() ? "/" : ""}`;
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (included >= MAX_DIRECTORY_ENTRIES || bytes + lineBytes + reservedBytes > MAX_FILE_BYTES) break;
    lines.push(line);
    bytes += lineBytes;
    included++;
  }
  if (included < entries.length) lines.push(truncationNotice(entries.length - included));
  return lines.join("\n");
}

/** Resolve @file references in text, returning attachments.
 *  Single-level only: @file refs inside resolved file contents are NOT
 *  followed as often leads to errors.
 *  Resolved content is treated as inert text.
 */
async function resolveFileReference(
  name: string,
  baseDir: string,
  source: Source,
): Promise<FileAttachment> {
  const filepath = resolvePath(name, baseDir);
  try {
    const stats = await stat(filepath);
    if (stats.isDirectory()) {
      return {
        kind: "file",
        source,
        resolvedPath: filepath,
        displayPath: name,
        content: await listDirectory(filepath),
      };
    }
    if (stats.size > MAX_FILE_BYTES) {
      return {
        kind: "file",
        source,
        resolvedPath: filepath,
        displayPath: name,
        content: "",
        skipped: true,
      };
    }
    const content = await readFile(filepath, "utf-8");
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      return {
        kind: "file",
        source,
        resolvedPath: filepath,
        displayPath: name,
        content: "",
        skipped: true,
      };
    }
    return {
      kind: "file",
      source,
      resolvedPath: filepath,
      displayPath: name,
      content,
    };
  } catch (error) {
    return {
      kind: "file",
      source,
      resolvedPath: filepath,
      displayPath: name,
      content: "",
      error: error instanceof Error ? error.message : String(error),
      errorCode:
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : undefined,
    };
  }
}

async function resolveFileRefs(
  text: string,
  baseDir: string,
  source: Source,
): Promise<FileAttachment[]> {
  return await Promise.all(
    extractFileRefs(text).map((name) =>
      resolveFileReference(name, baseDir, source),
    ),
  );
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

function isResolveReferencesRequest(
  data: unknown,
): data is ResolveReferencesRequest {
  if (!data || typeof data !== "object") return false;
  const request = data as Partial<ResolveReferencesRequest>;
  return (
    request.version === 1 &&
    typeof request.text === "string" &&
    typeof request.baseDir === "string"
  );
}

async function resolveReferencesForExtension(
  request: ResolveReferencesRequest,
  pi: ExtensionAPI,
  settings: Settings,
): Promise<ResolveReferencesResult> {
  const config = cfgFor(settings, "userInput");
  const candidates = [
    ...extractFileReferenceMatches(request.text).map((reference) => ({
      kind: "file" as const,
      ...reference,
    })),
    ...extractCommandRefs(request.text).map((reference) => ({
      kind: "command" as const,
      ...reference,
    })),
  ].sort((left, right) => left.index - right.index);
  const references: ReferenceResolution[] = [];

  for (const candidate of candidates) {
    if (candidate.kind === "file") {
      if (!config.files) {
        references.push({
          kind: "file",
          reference: candidate.path,
          index: candidate.index,
          status: "disabled",
          reason: "file resolution is disabled",
        });
        continue;
      }
      const attachment = await resolveFileReference(
        candidate.path,
        request.baseDir,
        "userInput",
      );
      const context =
        !attachment.skipped && !attachment.error
          ? formatAttachment(attachment)
          : undefined;
      references.push({
        kind: "file",
        reference: candidate.path,
        index: candidate.index,
        resolvedPath: attachment.resolvedPath,
        status: attachment.skipped
          ? "oversized"
          : attachment.errorCode === "ENOENT"
            ? "missing"
            : attachment.error
              ? "error"
              : "success",
        ...(context ? { context } : {}),
        ...(attachment.skipped
          ? { reason: `file exceeds ${MAX_FILE_BYTES} bytes` }
          : attachment.error
            ? { reason: attachment.error }
            : {}),
      });
      continue;
    }

    if (request.mode === "files" || !config.commands) {
      references.push({
        kind: "command",
        reference: candidate.command,
        index: candidate.index,
        status: "disabled",
        reason:
          request.mode === "files"
            ? "command execution is disabled in file-only mode"
            : "command resolution is disabled",
      });
      continue;
    }
    const { inlines } = await inlineBashRefs(
      candidate.fullMatch,
      request.baseDir,
      pi,
      "userInput",
    );
    const inline = inlines[0]!;
    const context =
      !inline.skipped && !inline.error
        ? `<bash command="${inline.command}">\n${inline.output}\n</bash>`
        : undefined;
    references.push({
      kind: "command",
      reference: candidate.command,
      index: candidate.index,
      status: inline.skipped ? "oversized" : inline.error ? "error" : "success",
      ...(context ? { context } : {}),
      ...(inline.skipped
        ? { reason: `command output exceeds ${MAX_BASH_BYTES} bytes` }
        : inline.error
          ? { reason: inline.error }
          : {}),
    });
  }

  return {
    context: references.flatMap((reference) =>
      reference.context ? [reference.context] : [],
    ),
    references,
  };
}

// ---------- display ----------

interface AttachmentLine {
  kind: "file" | "bash";
  label: string;
  /** Resolved absolute path, file items only. Used for terminal hyperlinks. */
  path?: string;
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
      path: a.resolvedPath,
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

  // Bash inlines captured from the input event. User text is kept as-is;
  // outputs are attached as a separate context message in before_agent_start.
  let pendingUserInlines: BashInline[] = [];

  // Extension commands bypass Pi's input and before_agent_start hooks. Expose
  // the same user-input resolution through the shared event bus so commands
  // that make their own model calls can opt in.
  pi.events.on(RESOLVE_REFERENCES_EVENT, (data) => {
    if (!isResolveReferencesRequest(data) || data.response) return;
    data.response = resolveReferencesForExtension(data, pi, settings);
  });

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
        const styledLabel = theme.fg("dim", ` ${item.label}`);
        const label =
          item.kind === "file" && item.path && getCapabilities().hyperlinks
            ? hyperlink(styledLabel, pathToFileURL(item.path).href)
            : styledLabel;
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

  // Resolve !`command` in user input, but keep the original text intact.
  // Outputs are attached as a separate context message (like @file), so the
  // user still sees what they typed. Runs before skill expansion.
  pi.on("input", async (event, ctx) => {
    if (!cfgFor(settings, "userInput").commands) return { action: "continue" };

    const matches = extractCommandRefs(event.text);
    if (matches.length === 0) return { action: "continue" };

    if (ctx.hasUI) {
      const label =
        matches.length === 1
          ? matches[0]!.command
          : `${matches.length} commands`;
      ctx.ui.setWidget("pi-resolve", (tui, theme) => {
        const loader = new Loader(
          tui,
          (s) => theme.fg("bashMode", s),
          (s) => theme.fg("dim", s),
          ` ${label}`,
        );
        loader.start();
        return loader;
      });
    }

    const { inlines } = await inlineBashRefs(
      event.text,
      sessionCwd,
      pi,
      "userInput",
    );

    if (ctx.hasUI) ctx.ui.setWidget("pi-resolve", undefined);

    if (inlines.length > 0) pendingUserInlines = inlines;
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event) => {
    const allAttachments: FileAttachment[] = [];
    // Display-only: inlined into their own text (system prompt), TUI display only
    const displayOnlyInlines: BashInline[] = [];
    // Context inlines: user input + skills — attached as a separate context message
    const contextInlines: BashInline[] = [];
    // User-input commands captured in the input event (original text kept as-is)
    const userInlines = pendingUserInlines;
    pendingUserInlines = [];
    contextInlines.push(...userInlines);
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
        ? await resolveFileRefs(inlinedSystem, sessionCwd, "systemPrompt")
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
        const skillFileRefs = await resolveFileRefs(
          substituted,
          skill.baseDir,
          "skill",
        );
        allAttachments.push(...skillFileRefs);

        // Also resolve @file refs in trailing arguments (relative to session cwd)
        if (skill.args) {
          const argsFileRefs = await resolveFileRefs(
            skill.args,
            sessionCwd,
            "skill",
          );
          allAttachments.push(...argsFileRefs);
        }
      }
    } else if (cfgFor(settings, "userInput").files) {
      // Regular user input: commands were captured in the input event (attached
      // as context, text kept as-is). Here we only resolve @file refs.
      const inputFileRefs = await resolveFileRefs(
        prompt,
        sessionCwd,
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

      // Context inlines (user input + skills) go into message content as a
      // separate context message. Display-only inlines (system prompt) are
      // already inlined into their own text.
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
