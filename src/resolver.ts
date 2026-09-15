import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { extractCommandRefs, referenceCandidates } from "./matcher.ts";
import { cfgFor, type Limits, type Settings, type Source } from "./settings.ts";

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

export interface FileAttachment {
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

export interface BashInline {
  kind: "bash";
  source: Source;
  command: string;
  output: string;
  error?: string;
  skipped?: boolean;
  budgetExceeded?: boolean;
}

type ResolvedReference = FileAttachment | BashInline;

interface Budget {
  remaining: number;
}

export interface ResolveSourceCtx {
  settings: Settings;
  budget: Budget;
  seenFiles: Set<string>;
  cwd: string;
}

export interface SourceResolution {
  attachments: FileAttachment[];
  inlines: BashInline[];
}

const MAX_DIRECTORY_ENTRIES = 1_000;
const BATCH_SIZE = 4;

/** Only admitted successes count, including attachment wrappers. Failures are exempt. */
function charge(budget: Budget, text: string): boolean {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > budget.remaining) return false;
  budget.remaining -= bytes;
  return true;
}

/** Bound raw stdout + stderr bytes before decoding or trimming either stream. */
function captureCommand(command: string, cwd: string, maxBytes: number): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  killed: boolean;
  oversized: boolean;
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
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code,
        killed: killed || signal !== null,
        oversized,
      });
    });
  });
}

function resolvePath(name: string, baseDir: string): string {
  const expanded = name.startsWith("~/") ? join(homedir(), name.slice(2)) : name;
  return isAbsolute(expanded) ? expanded : join(baseDir, expanded);
}

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
      const output = (result.stderr.trim() || result.stdout.trim())
        .replace(/\x1b\[[0-9;]*m/g, "").slice(0, 500);
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

async function listDirectory(filepath: string, maxBytes: number): Promise<string | undefined> {
  const entries = await readdir(filepath, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (entries.length === 0) return "Directory listing (immediate entries):\n(empty directory)";

  const lines = ["Directory listing (immediate entries):"];
  const truncationNotice = (omitted: number) => `[truncated: ${omitted} entries omitted]`;
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

async function resolveFileReference(
  item: FileAttachment, maxBytes: number, directoryMaxBytes: number,
): Promise<FileAttachment> {
  try {
    const stats = await stat(item.resolvedPath);
    if (stats.isDirectory()) {
      // Per-file limits truncate listings. Remaining total capacity can only omit them.
      const content = await listDirectory(item.resolvedPath, directoryMaxBytes);
      if (content === undefined || Buffer.byteLength(content, "utf8") > maxBytes) {
        return { ...item, skipped: true };
      }
      return { ...item, content };
    }
    if (!stats.isFile()) throw new Error("not a regular file");
    // O_NONBLOCK prevents a raced replacement with a FIFO from blocking open.
    await using handle = await open(item.resolvedPath, constants.O_RDONLY | constants.O_NONBLOCK);
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) throw new Error("not a regular file");
    if (openedStats.size > maxBytes) return { ...item, skipped: true };

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
      return { ...item, skipped: true };
    }
    return { ...item, content };
  } catch (error) {
    return {
      ...item,
      error: error instanceof Error ? error.message : String(error),
      errorCode:
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : undefined,
    };
  }
}

function resolutionStatus(item: ResolvedReference): ReferenceResolutionStatus {
  if (item.skipped) return "oversized";
  if (item.kind === "file" && item.errorCode === "ENOENT") return "missing";
  return item.error ? "error" : "success";
}

/** Failure context never includes captured output or operational error details. */
function formatFailure(item: ResolvedReference): string {
  const status = resolutionStatus(item);
  let reason: string;
  if (item.budgetExceeded) reason = "total byte budget exceeded";
  else if (item.kind === "file") {
    reason = status === "oversized" ? "file exceeds size limit"
      : status === "missing" ? "file not found" : "unable to read file";
  } else {
    reason = status === "oversized" ? "command output exceeds size limit" : "command failed";
  }
  const rawReference = item.kind === "file" ? item.displayPath : item.command;
  const label = rawReference.length > 160 ? `${rawReference.slice(0, 160)} [reference shortened]` : rawReference;
  const reference = label
    .replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\r/g, "&#13;").replace(/\n/g, "&#10;");
  return `<${item.kind} ${item.kind === "file" ? "path" : "command"}="${reference}" status="${status}" reason="${reason}" />`;
}

/** Resolution is single-level. Imported file contents and command output stay inert. */
export function formatContext(item: ResolvedReference): string {
  if (item.skipped || item.error) return formatFailure(item);
  return item.kind === "file"
    ? `<file path="${item.displayPath}">\n${item.content}\n</file>`
    : `<bash command="${item.command}">\n${item.output}\n</bash>`;
}

function importedText(item: ResolvedReference): string {
  return item.kind === "bash" && item.source === "systemPrompt" ? item.output : formatContext(item);
}

async function captureFile(
  name: string, baseDir: string, source: Source, limits: Limits, remaining: number,
): Promise<FileAttachment> {
  const empty: FileAttachment = {
    kind: "file", source, resolvedPath: resolvePath(name, baseDir), displayPath: name, content: "",
  };
  const available = remaining - Buffer.byteLength(formatContext(empty), "utf8");
  if (available < 0) return { ...empty, skipped: true, budgetExceeded: true };
  const maxBytes = Math.min(limits.maxFileBytes, available);
  const item = await resolveFileReference(empty, maxBytes, limits.maxFileBytes);
  if (item.skipped) item.budgetExceeded = available < limits.maxFileBytes;
  return item;
}

async function captureCommandReference(
  command: string, cwd: string, source: Source, limits: Limits, remaining: number,
): Promise<BashInline> {
  const empty: BashInline = { kind: "bash", source, command, output: "" };
  const available = remaining - Buffer.byteLength(importedText(empty), "utf8");
  if (available <= 0) return { ...empty, skipped: true, budgetExceeded: true };
  const item = await resolveCommand(command, cwd, source, Math.min(limits.maxCommandBytes, available));
  if (item.skipped) item.budgetExceeded = available < limits.maxCommandBytes;
  return item;
}

/** Capture against a shared capacity snapshot, then charge once in reference order.
 * Commands in an active batch can have side effects even if admission rejects them.
 * Rejected output is discarded before the next batch starts. */
async function resolveBatches<T>(
  candidates: T[], budget: Budget,
  capture: (candidate: T, remaining: number) => Promise<ResolvedReference | undefined>,
): Promise<(ResolvedReference | undefined)[]> {
  const results: (ResolvedReference | undefined)[] = [];
  for (let offset = 0; offset < candidates.length; offset += BATCH_SIZE) {
    const remaining = budget.remaining;
    const batch = await Promise.all(candidates.slice(offset, offset + BATCH_SIZE).map((candidate) =>
      capture(candidate, remaining),
    ));
    for (const item of batch) {
      if (item && !item.error && !item.skipped && !charge(budget, importedText(item))) {
        item.skipped = true;
        item.budgetExceeded = true;
        if (item.kind === "file") item.content = "";
        else item.output = "";
      }
      results.push(item);
    }
  }
  return results;
}

export async function resolveSource(
  ctx: ResolveSourceCtx, text: string, source: Source, baseDir = ctx.cwd, fileText = text,
): Promise<SourceResolution> {
  const attachments: FileAttachment[] = [];
  const inlines: BashInline[] = [];
  const config = cfgFor(ctx.settings, source);
  const results = await resolveBatches(referenceCandidates(text, fileText), ctx.budget, async (candidate, remaining) => {
    if (candidate.kind === "file" && config.files) {
      const path = resolvePath(candidate.path, baseDir);
      if (ctx.seenFiles.has(path)) return;
      ctx.seenFiles.add(path);
      return await captureFile(candidate.path, baseDir, source, ctx.settings.limits, remaining);
    }
    if (candidate.kind === "command" && config.commands) {
      return await captureCommandReference(candidate.command, ctx.cwd, source, ctx.settings.limits, remaining);
    }
  });
  for (const item of results) {
    if (item?.kind === "file") attachments.push(item);
    else if (item) inlines.push(item);
  }
  return { attachments, inlines };
}

/** Shared events have independent budgets and intentionally do not deduplicate files. */
export async function resolveReferencesForExtension(
  request: ResolveReferencesRequest,
  settings: Settings,
): Promise<ResolveReferencesResult> {
  const config = cfgFor(settings, "extension");
  const budget = { remaining: settings.limits.maxTotalBytes };
  const candidates = referenceCandidates(request.text);
  const references: ReferenceResolution[] = [];
  const resolved = await resolveBatches(candidates, budget, async (candidate, remaining) => {
    if (candidate.kind === "file" && config.files) {
      return await captureFile(candidate.path, request.baseDir, "extension", settings.limits, remaining);
    }
    if (candidate.kind === "command" && request.mode !== "files" && config.commands) {
      return await captureCommandReference(candidate.command, request.baseDir, "extension", settings.limits, remaining);
    }
  });

  for (const [index, candidate] of candidates.entries()) {
    const reference = {
      kind: candidate.kind,
      reference: candidate.kind === "file" ? candidate.path : candidate.command,
      index: candidate.index,
    };
    const disabled = candidate.kind === "file" ? !config.files : request.mode === "files" || !config.commands;
    if (disabled) {
      references.push({
        ...reference,
        status: "disabled",
        reason: candidate.kind === "file" ? "file resolution is disabled"
          : request.mode === "files" ? "command execution is disabled in file-only mode"
            : "command resolution is disabled",
      });
      continue;
    }
    const item = resolved[index];
    if (!item || item.kind !== (candidate.kind === "file" ? "file" : "bash")) {
      throw new Error(`Missing ${candidate.kind} resolution`);
    }
    const status = resolutionStatus(item);
    let reason = item.error;
    if (item.skipped) {
      reason = item.budgetExceeded ? "total byte budget exceeded"
        : item.kind === "file" ? `file exceeds ${settings.limits.maxFileBytes} bytes`
          : `command output exceeds ${settings.limits.maxCommandBytes} bytes`;
    }
    references.push({
      ...reference,
      status,
      ...(item.kind === "file" ? { resolvedPath: item.resolvedPath } : {}),
      ...(status === "success" ? { context: formatContext(item) } : {}),
      ...(reason ? { reason } : {}),
    });
  }

  return {
    context: references.flatMap((reference) => reference.context ? [reference.context] : []),
    references,
  };
}

/** Reattached cached output counts once in this turn, not again for its cache. */
export function applySystemInlines(
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
