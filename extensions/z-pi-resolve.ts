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
 *     into the prompt text itself, cached output reapplied each turn)
 *   - Skills: !`command` and @file resolved after expansion, with $ARGUMENTS
 *     substitution and skill baseDir as cwd
 *   - Errors: attached with error marker, shown as warnings in TUI
 *
 * Settings:
 *   Read from `~/.pi/agent/pi-resolve.json` (global) and
 *   `<cwd>/.pi/pi-resolve.json` (project, overrides global).
 *
 *   {
 *     "limits": { "maxFileBytes": 100000, "maxCommandBytes": 100000,
 *                 "maxTotalBytes": 1000000 },
 *     "sources": { "template": { "commands": true } }
 *   }
 *
 *   Files default on everywhere. Commands default on only for direct input
 *   and trusted system/AGENTS content. Summaries default on only for direct
 *   input and templates. Explicit defaults override built-in source defaults;
 *   explicit source fields override global/project defaults. Project fields
 *   can relax global fields. Limits merge per field as positive safe integers.
 *
 * Byte contract:
 *   - A turn admits direct input, system, then expanded template/skill content
 *     (skill trailing files last), each admitted in reference order. Capture
 *     runs in batches of at most four, each bounded by the batch's starting
 *     remaining capacity. Final admission discards over-budget captures.
 *     Direct references resolve in input; its remaining budget carries into
 *     before_agent_start for system and post-expansion references.
 *   - Total counts UTF-8 successful file/bash attachment text INCLUDING wrappers,
 *     plus successful system inline output (no wrapper). Deduplicated turn files
 *     count once. Each shared event gets an independent budget and no deduplication.
 *   - Reapplied system output counts once each turn; storing its cache adds no
 *     charge. Prior conversation/history attachments are not new turn imports.
 *   - File limits cover raw and decoded UTF-8 bytes; command capture bounds raw
 *     stdout + stderr together before trimming. Only stdout is attached on success.
 *   - Capture/read bounds also use remaining total capacity. Whole oversized
 *     references are omitted, with safe failure notices exempt from the budget.
 *     Commands with no output capacity are not started. Commands in an active
 *     batch can have side effects even if ordered final admission rejects them;
 *     omission does not roll back those effects.
 *   - Directory entry count remains capped at 1000 with an explicit listing
 *     notice. Byte overflow omits the whole listing rather than clipping it.
 *   - Failure markers, original prompts, reference literals, and UI metadata are
 *     not imported successes and do not consume the budget. Failure marker labels
 *     longer than 160 UTF-16 units are explicitly shortened before escaping.
 */

import { constants, existsSync, readFileSync } from "node:fs";
import { open, stat, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
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
  extractFileReferenceMatches,
  extractCommandRefs,
} from "./matcher.ts";

// ---------- settings ----------

import {
  DEFAULT_SETTINGS,
  cfgFor,
  mergeSettings,
  shouldDisplay,
  validateSettings,
  type Settings,
  type Limits,
  type Source,
} from "./settings.ts";

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

function readSettings(path: string) {
  if (!existsSync(path)) return {};
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    // JSON parse errors can include configuration contents. Do not log them.
    console.error(`[pi-resolve] Unable to read or parse settings at ${path}; ignoring file`);
    return {};
  }
  const { settings, issues } = validateSettings(value);
  for (const issue of issues) {
    console.error(`[pi-resolve] ${path}: ${issue.path}: ${issue.code}; ignoring setting`);
  }
  return settings;
}

function loadSettings(cwd: string): Settings {
  return mergeSettings(
    readSettings(join(getAgentDir(), "pi-resolve.json")),
    readSettings(join(cwd, ".pi", "pi-resolve.json")),
  );
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
  budgetExceeded?: boolean;
}

interface BashInline {
  kind: "bash";
  source: Source;
  command: string;
  output: string;
  error?: string;
  skipped?: boolean;
  budgetExceeded?: boolean;
}

interface SkillBlock {
  name: string;
  location: string;
  baseDir: string;
  body: string;
  args: string;
}

// ---------- constants ----------

const MAX_DIRECTORY_ENTRIES = 1_000;

interface Budget {
  remaining: number;
}

function charge(budget: Budget, text: string): boolean {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > budget.remaining) return false;
  budget.remaining -= bytes;
  return true;
}

/** Bound raw stdout + stderr bytes before decoding or trimming either stream. */
function captureCommand(command: string, cwd: string, maxBytes: number): Promise<{
  stdout: string; stderr: string; code: number | null; killed: boolean; oversized: boolean;
}> {
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn("sh", ["-c", command], {
      cwd, detached: grouped, stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let killed = false;
    let oversized = false;
    const cleanupGroup = () => {
      // Killing only sh leaves grandchildren running and holding capture pipes open.
      try {
        if (grouped && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
      }
    };
    const stop = () => {
      cleanupGroup();
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(() => {
      killed = true;
      stop();
    }, 10_000);
    const capture = (chunks: Buffer[]) => (chunk: Buffer) => {
      if (oversized || killed) return;
      if (chunk.length > maxBytes - bytes) {
        oversized = true;
        stop();
        return;
      }
      bytes += chunk.length;
      chunks.push(chunk);
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.on("exit", cleanupGroup);
    child.on("error", (error) => {
      clearTimeout(timer);
      stop();
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), code, killed: killed || signal !== null, oversized });
    });
  });
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

/** Resolve one command; imported output remains inert. */
async function resolveCommand(
  command: string, cwd: string, source: Source, maxBytes: number,
): Promise<BashInline> {
  const item: BashInline = { kind: "bash", source, command, output: "" };
  try {
    const result = await captureCommand(command, cwd, maxBytes);
    const stdout = result.stdout.trimEnd();
    if (result.oversized || Buffer.byteLength(stdout, "utf8") > maxBytes) {
      return { ...item, skipped: true };
    }
    if (result.killed || result.code !== 0) {
      // eslint-disable-next-line no-control-regex
      const output = (result.stderr.trim() || result.stdout.trim()).replace(/\x1b\[[0-9;]*m/g, "").slice(0, 500);
      const detail = result.killed ? "command timed out or was killed" : output || `exit code ${result.code}`;
      console.error(`[pi-resolve] Shell error (${command}): ${detail}`);
      return { ...item, error: detail };
    }
    return { ...item, output: stdout };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[pi-resolve] Shell error (${command}): ${detail}`);
    return { ...item, error: detail };
  }
}

// ---------- file resolution ----------

async function listDirectory(filepath: string, maxBytes: number): Promise<string | undefined> {
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
    if (included >= MAX_DIRECTORY_ENTRIES || bytes + lineBytes + reservedBytes > maxBytes) break;
    lines.push(line);
    bytes += lineBytes;
    included++;
  }
  if (included < entries.length) lines.push(truncationNotice(entries.length - included));
  const content = lines.join("\n");
  return Buffer.byteLength(content, "utf8") > maxBytes ? undefined : content;
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
  maxBytes: number,
  directoryMaxBytes = maxBytes,
): Promise<FileAttachment> {
  const filepath = resolvePath(name, baseDir);
  try {
    const stats = await stat(filepath);
    if (stats.isDirectory()) {
      const content = await listDirectory(filepath, directoryMaxBytes);
      const oversized = content === undefined || Buffer.byteLength(content, "utf8") > maxBytes;
      return {
        kind: "file",
        source,
        resolvedPath: filepath,
        displayPath: name,
        content: oversized ? "" : content!,
        skipped: oversized,
      };
    }
    if (!stats.isFile()) throw new Error("not a regular file");
    // O_NONBLOCK prevents a raced replacement with a FIFO from blocking open.
    await using handle = await open(filepath, constants.O_RDONLY | constants.O_NONBLOCK);
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) throw new Error("not a regular file");
    if (openedStats.size > maxBytes) {
      return {
        kind: "file",
        source,
        resolvedPath: filepath,
        displayPath: name,
        content: "",
        skipped: true,
      };
    }
    // One sentinel byte detects growth after stat; never read the whole growing file.
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (bytes <= maxBytes) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes - bytes + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytes);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const content = bytes > maxBytes ? "" : Buffer.concat(chunks).toString("utf8");
    if (bytes > maxBytes || Buffer.byteLength(content, "utf8") > maxBytes) {
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

// ---------- format ----------

function formatAttachment(a: FileAttachment): string {
  return `<file path="${a.displayPath}">\n${a.content}\n</file>`;
}

/** Failure context never includes captured output or operational error details. */
function formatFailure(item: FileAttachment | BashInline): string {
  const status = item.skipped ? "oversized"
    : item.kind === "file" && item.errorCode === "ENOENT" ? "missing" : "error";
  const reason = item.budgetExceeded ? "total byte budget exceeded" : item.kind === "file"
    ? status === "oversized" ? "file exceeds size limit" : status === "missing" ? "file not found" : "unable to read file"
    : status === "oversized" ? "command output exceeds size limit" : "command failed";
  const rawReference = item.kind === "file" ? item.displayPath : item.command;
  const label = rawReference.length > 160 ? `${rawReference.slice(0, 160)} [reference shortened]` : rawReference;
  const reference = label
    .replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\r/g, "&#13;").replace(/\n/g, "&#10;");
  return `<${item.kind} ${item.kind === "file" ? "path" : "command"}="${reference}" status="${status}" reason="${reason}" />`;
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

function formatBash(item: BashInline): string {
  return `<bash command="${item.command}">\n${item.output}\n</bash>`;
}

async function resolveFileBudgeted(
  name: string, baseDir: string, source: Source, limits: Limits, budget: Budget,
): Promise<FileAttachment> {
  const empty: FileAttachment = {
    kind: "file", source, resolvedPath: resolvePath(name, baseDir), displayPath: name, content: "",
  };
  const available = budget.remaining - Buffer.byteLength(formatAttachment(empty), "utf8");
  if (available < 0) return { ...empty, skipped: true, budgetExceeded: true };
  const maxBytes = Math.min(limits.maxFileBytes, available);
  const item = await resolveFileReference(name, baseDir, source, maxBytes, limits.maxFileBytes);
  if (item.skipped) item.budgetExceeded = available < limits.maxFileBytes;
  if (!item.skipped && !item.error && !charge(budget, formatAttachment(item))) {
    return { ...empty, skipped: true, budgetExceeded: true };
  }
  return item;
}

async function resolveCommandBudgeted(
  command: string, cwd: string, source: Source, limits: Limits, budget: Budget,
): Promise<BashInline> {
  const empty: BashInline = { kind: "bash", source, command, output: "" };
  const overhead = source === "systemPrompt" ? 0 : Buffer.byteLength(formatBash(empty), "utf8");
  const available = budget.remaining - overhead;
  if (available <= 0) return { ...empty, skipped: true, budgetExceeded: true };
  const item = await resolveCommand(command, cwd, source, Math.min(limits.maxCommandBytes, available));
  if (item.skipped) item.budgetExceeded = available < limits.maxCommandBytes;
  if (!item.skipped && !item.error && !charge(budget, source === "systemPrompt" ? item.output : formatBash(item))) {
    return { ...empty, skipped: true, budgetExceeded: true };
  }
  return item;
}

function referenceCandidates(text: string, fileText = text) {
  return [
    ...extractFileReferenceMatches(fileText).map((reference) => ({ kind: "file" as const, ...reference })),
    ...extractCommandRefs(text).map((reference) => ({ kind: "command" as const, ...reference })),
  ].sort((left, right) => left.index - right.index);
}

/** Expansion may duplicate arguments. Without a source map, identical expanded
 * references conservatively retain direct-input policy, including disabled refs. */
function maskDirectReferences(text: string, input: string, kind?: "file" | "command"): string {
  const key = (candidate: ReturnType<typeof referenceCandidates>[number]) =>
    candidate.kind === "file" ? `file:${candidate.path}` : `command:${candidate.command}`;
  const captured = new Set(referenceCandidates(input)
    .filter((candidate) => !kind || candidate.kind === kind).map(key));
  const consumed = referenceCandidates(text).filter((candidate) => captured.has(key(candidate)));
  for (const match of consumed.reverse()) {
    // Preserve argument positions for subsequent skill $N substitution.
    const mask = match.fullMatch.replace(/\S/g, "_");
    text = text.slice(0, match.index) + mask + text.slice(match.index + match.fullMatch.length);
  }
  return text;
}

interface ResolveSourceCtx {
  settings: Settings;
  budget: Budget;
  seenFiles: Set<string>;
  cwd: string;
}

/** Capture at most four references against a snapshot, then admit in text order.
 * A command in the current batch can run even if final admission rejects it.
 * Rejected output is discarded before the next batch starts.
 */
async function resolveBatches<T>(
  candidates: T[], budget: Budget,
  resolve: (candidate: T, budget: Budget) => Promise<FileAttachment | BashInline | undefined>,
): Promise<(FileAttachment | BashInline | undefined)[]> {
  const results: (FileAttachment | BashInline | undefined)[] = [];
  for (let offset = 0; offset < candidates.length; offset += 4) {
    const remaining = budget.remaining;
    const batch = await Promise.all(candidates.slice(offset, offset + 4).map((candidate) =>
      resolve(candidate, { remaining }),
    ));
    for (const item of batch) {
      if (item && !item.error && !item.skipped) {
        const payload = item.kind === "file" ? formatAttachment(item)
          : item.source === "systemPrompt" ? item.output : formatBash(item);
        if (!charge(budget, payload)) {
          item.skipped = true;
          item.budgetExceeded = true;
          if (item.kind === "file") item.content = "";
          else item.output = "";
        }
      }
      results.push(item);
    }
  }
  return results;
}

/** Bounded capture with deterministic ordered attachment admission. */
async function resolveSource(
  ctx: ResolveSourceCtx, text: string, source: Source, baseDir = ctx.cwd, fileText = text,
): Promise<{ attachments: FileAttachment[]; inlines: BashInline[] }> {
  const attachments: FileAttachment[] = [];
  const inlines: BashInline[] = [];
  const config = cfgFor(ctx.settings, source);
  const results = await resolveBatches(referenceCandidates(text, fileText), ctx.budget, async (candidate, budget) => {
    if (candidate.kind === "file" && config.files) {
      const path = resolvePath(candidate.path, baseDir);
      if (ctx.seenFiles.has(path)) return;
      ctx.seenFiles.add(path);
      return await resolveFileBudgeted(candidate.path, baseDir, source, ctx.settings.limits, budget);
    } else if (candidate.kind === "command" && config.commands) {
      return await resolveCommandBudgeted(candidate.command, ctx.cwd, source, ctx.settings.limits, budget);
    }
  });
  for (const item of results) {
    if (item?.kind === "file") attachments.push(item);
    else if (item) inlines.push(item);
  }
  return { attachments, inlines };
}

async function resolveReferencesForExtension(
  request: ResolveReferencesRequest,
  settings: Settings,
): Promise<ResolveReferencesResult> {
  const config = cfgFor(settings, "extension");
  const budget = { remaining: settings.limits.maxTotalBytes };
  const candidates = referenceCandidates(request.text);
  const references: ReferenceResolution[] = [];
  const resolved = await resolveBatches(candidates, budget, async (candidate, captureBudget) => {
    if (candidate.kind === "file" && config.files) {
      return await resolveFileBudgeted(candidate.path, request.baseDir, "extension", settings.limits, captureBudget);
    }
    if (candidate.kind === "command" && request.mode !== "files" && config.commands) {
      return await resolveCommandBudgeted(candidate.command, request.baseDir, "extension", settings.limits, captureBudget);
    }
  });

  for (const [index, candidate] of candidates.entries()) {
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
      const attachment = resolved[index];
      if (attachment?.kind !== "file") throw new Error("Missing file resolution");
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
          ? { reason: attachment.budgetExceeded ? "total byte budget exceeded" : `file exceeds ${settings.limits.maxFileBytes} bytes` }
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
    const inline = resolved[index];
    if (inline?.kind !== "bash") throw new Error("Missing command resolution");
    const context =
      !inline.skipped && !inline.error
        ? formatBash(inline)
        : undefined;
    references.push({
      kind: "command",
      reference: candidate.command,
      index: candidate.index,
      status: inline.skipped ? "oversized" : inline.error ? "error" : "success",
      ...(context ? { context } : {}),
      ...(inline.skipped
        ? { reason: inline.budgetExceeded ? "total byte budget exceeded" : `command output exceeds ${settings.limits.maxCommandBytes} bytes` }
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
        result === "skipped" ? b.budgetExceeded ? "total byte budget exceeded" : "too large" : result === "error" ? b.error : undefined,
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
        result === "skipped" ? a.budgetExceeded ? "total byte budget exceeded" : "too large" : result === "error" ? a.error : undefined,
    });
  }

  return { items };
}

/** Reattached cached output counts once in this turn, not again for its cache. */
function applySystemInlines(
  text: string, inlines: BashInline[], budget?: Budget, failures: BashInline[] = [],
): string {
  const cached = [...inlines];
  const replacements = extractCommandRefs(text).map((match) => {
    const index = cached.findIndex((inline) => inline.command === match.command);
    const inline = index < 0 ? undefined : cached.splice(index, 1)[0];
    if (!inline || inline.error || inline.skipped) return { ...match, output: match.fullMatch };
    if (budget && !charge(budget, inline.output)) {
      failures.push({ ...inline, output: "", skipped: true, budgetExceeded: true });
      return { ...match, output: match.fullMatch };
    }
    return { ...match, output: inline.output };
  });
  for (const match of replacements.reverse()) {
    text = text.slice(0, match.index) + match.output + text.slice(match.index + match.fullMatch.length);
  }
  return text;
}

// ---------- extension hook ----------

export default function (pi: ExtensionAPI) {
  let sessionCwd: string = process.cwd();
  let systemContextInjected = false;
  let systemInlines: BashInline[] = [];
  let settings: Settings = DEFAULT_SETTINGS;

  // Input precedes template/skill expansion. Carry provenance and budget together.
  let pendingTurn: {
    input: string;
    ctx: ResolveSourceCtx;
    direct: Awaited<ReturnType<typeof resolveSource>>;
  } | undefined;

  // Extension commands bypass Pi's input and before_agent_start hooks. Expose
  // the same user-input resolution through the shared event bus so commands
  // that make their own model calls can opt in.
  pi.events.on(RESOLVE_REFERENCES_EVENT, (data) => {
    if (!isResolveReferencesRequest(data) || data.response) return;
    data.response = resolveReferencesForExtension(data, settings);
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
    systemInlines = [];
    pendingTurn = undefined;
    settings = loadSettings(sessionCwd);
  });

  pi.on("input", async (event, extensionCtx) => {
    pendingTurn = undefined;
    const input = event.text;
    const ctx: ResolveSourceCtx = {
      settings, budget: { remaining: settings.limits.maxTotalBytes }, seenFiles: new Set(), cwd: sessionCwd,
    };
    const directConfig = cfgFor(settings, "userInput");
    const commands = directConfig.commands ? extractCommandRefs(input ?? "") : [];
    const showLoader = extensionCtx?.hasUI && directConfig.display === "always" && commands.length > 0;
    let loader: Loader | undefined;
    let direct: Awaited<ReturnType<typeof resolveSource>>;
    try {
      if (showLoader) {
        const label = commands.length === 1 ? commands[0]!.command : `${commands.length} commands`;
        extensionCtx.ui.setWidget("pi-resolve", (tui, theme) => {
          loader = new Loader(tui, (s) => theme.fg("bashMode", s), (s) => theme.fg("dim", s), ` ${label}`);
          loader.start();
          return loader;
        });
      }
      direct = await resolveSource(ctx, input ?? "", "userInput");
    } finally {
      loader?.stop();
      if (showLoader) extensionCtx.ui.setWidget("pi-resolve", undefined);
    }
    pendingTurn = { input, ctx, direct };
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event) => {
    const turn = pendingTurn;
    pendingTurn = undefined;
    const input = turn?.input;
    const ctx: ResolveSourceCtx = turn?.ctx ?? {
      settings, budget: { remaining: settings.limits.maxTotalBytes }, seenFiles: new Set(), cwd: sessionCwd,
    };
    const allAttachments = [...(turn?.direct.attachments ?? [])];
    // Successful system output is inlined, not attached a second time.
    const displayOnlyInlines: BashInline[] = [];
    const contextInlines = [...(turn?.direct.inlines ?? [])];
    let modifiedSystemPrompt: string | undefined;

    // --- System prompt — first turn only ---
    if (!systemContextInjected) {
      const resolved = await resolveSource(ctx, event.systemPrompt, "systemPrompt");
      systemInlines = resolved.inlines;
      displayOnlyInlines.push(...systemInlines);
      allAttachments.push(...resolved.attachments);
      systemContextInjected = true;
      modifiedSystemPrompt = applySystemInlines(event.systemPrompt, systemInlines);
    } else if (systemInlines.length > 0) {
      // Pi rebuilds the base system prompt each turn. Reapply captured output
      // without executing commands or replacing other extensions' context.
      modifiedSystemPrompt = applySystemInlines(event.systemPrompt, systemInlines, ctx.budget, displayOnlyInlines);
    }

    // --- User input / skill content — every turn ---
    const prompt = event.prompt;
    const skill = parseSkillBlock(prompt);

    if (skill) {
      const commandArgs = maskDirectReferences(skill.args, input ?? "", "command");
      const substituted = substituteSkillArgs(skill.body, commandArgs);
      const fileArgs = maskDirectReferences(skill.args, input ?? "", "file");
      const fileText = substituteSkillArgs(skill.body, fileArgs);
      const resolved = await resolveSource(ctx, substituted, "skill", skill.baseDir, fileText);
      allAttachments.push(...resolved.attachments);
      contextInlines.push(...resolved.inlines);
      // Trailing args use the session directory, never execute them a second time.
      const args = extractFileReferenceMatches(fileArgs).map(({ fullMatch }) => fullMatch).join("\n");
      const resolvedArgs = await resolveSource(ctx, args, "skill");
      allAttachments.push(...resolvedArgs.attachments);
    } else if (prompt !== input) {
      // References present in direct input retain its policy, including disabled
      // references. Only newly introduced occurrences belong to the template.
      const expanded = maskDirectReferences(prompt, input ?? "");
      const resolved = await resolveSource(ctx, expanded, "template");
      allAttachments.push(...resolved.attachments);
      contextInlines.push(...resolved.inlines);
    }

    const allDisplayInlines = [...displayOnlyInlines, ...contextInlines];
    const hasContent =
      allAttachments.length > 0 ||
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

      // Successful system commands are already inlined. Failures retain their
      // literal reference there and also need explicit model-facing context.
      for (const b of contextInlines) {
        content.push({
          type: "text",
          text: b.skipped || b.error ? formatFailure(b)
            : formatBash(b),
        });
      }
      for (const b of displayOnlyInlines) {
        if (b.skipped || b.error) content.push({ type: "text", text: formatFailure(b) });
      }

      for (const a of allAttachments) {
        content.push({ type: "text", text: a.skipped || a.error ? formatFailure(a) : formatAttachment(a) });
      }

      const details = buildDetails(allAttachments, allDisplayInlines, settings);
      result.message = {
        customType: "context",
        content,
        display: details.items.length > 0,
        details,
      };
    }

    return result;
  });
}
