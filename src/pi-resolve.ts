import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Container,
  getCapabilities,
  hyperlink,
  Loader,
  Text,
} from "@earendil-works/pi-tui";
import {
  SKILL_BLOCK_REGEX,
  extractFileReferenceMatches,
  extractCommandRefs,
  maskDirectReferences,
} from "./matcher.ts";
import {
  applySystemInlines,
  formatContext,
  resolveReferencesForExtension,
  resolveSource,
  type BashInline,
  type FileAttachment,
  type ResolveReferencesRequest,
  type ResolveSourceCtx,
  type SourceResolution,
} from "./resolver.ts";
import {
  DEFAULT_SETTINGS,
  cfgFor,
  mergeSettings,
  shouldDisplay,
  validateSettings,
  type Settings,
} from "./settings.ts";

export type {
  ReferenceResolutionStatus,
  ReferenceResolution,
  ResolveReferencesResult,
  ResolveReferencesRequest,
} from "./resolver.ts";

export const RESOLVE_REFERENCES_EVENT = "pi-resolve:resolve";

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

function isResolveReferencesRequest(data: unknown): data is ResolveReferencesRequest {
  if (!data || typeof data !== "object") return false;
  const request = data as Partial<ResolveReferencesRequest>;
  return request.version === 1 && typeof request.text === "string" && typeof request.baseDir === "string";
}

function parseSkillBlock(text: string) {
  const match = text.match(SKILL_BLOCK_REGEX);
  if (!match) return null;
  return { baseDir: match[3]!, body: match[4]!, args: match[5]?.trim() ?? "" };
}

function substituteSkillArgs(body: string, args: string): string {
  const argList = args ? args.split(/\s+/) : [];
  // Indexed forms must precede $ARGUMENTS. Braced shell expressions stay untouched.
  return body
    .replace(/\$ARGUMENTS\[(\d+)]/g, (_match, index) => argList[parseInt(index)] ?? "")
    .replace(/\$ARGUMENTS/g, args)
    .replace(/\$(\d+)(?![}\w])/g, (_match, index) => argList[parseInt(index)] ?? "");
}

interface AttachmentLine {
  kind: "file" | "bash";
  label: string;
  /** Resolved absolute path for terminal hyperlinks; files only. */
  path?: string;
  lines: number;
  result: "ok" | "error" | "skipped";
  message?: string;
}

interface ContextDetails {
  items: AttachmentLine[];
}

function buildDetails(
  attachments: FileAttachment[],
  inlines: BashInline[],
  settings: Settings,
): ContextDetails {
  const items: AttachmentLine[] = [];
  for (const item of [...inlines, ...attachments]) {
    const result = item.skipped ? "skipped" : item.error ? "error" : "ok";
    if (!shouldDisplay(cfgFor(settings, item.source).display, result)) continue;
    const content = item.kind === "file" ? item.content : item.output;
    let message: string | undefined;
    if (result === "skipped") message = item.budgetExceeded ? "total byte budget exceeded" : "too large";
    else if (result === "error") message = item.error;
    items.push({
      kind: item.kind,
      label: item.kind === "file" ? item.displayPath : item.command,
      ...(item.kind === "file" ? { path: item.resolvedPath } : {}),
      lines: result === "ok" && content ? content.split("\n").length : 0,
      result,
      message,
    });
  }
  return { items };
}

export default function (pi: ExtensionAPI): void {
  let sessionCwd = process.cwd();
  let systemContextInjected = false;
  let systemInlines: BashInline[] = [];
  let settings: Settings = DEFAULT_SETTINGS;

  // Input precedes template/skill expansion. Carry provenance and budget together.
  let pendingTurn: {
    input: string;
    source: "userInput" | "extension";
    ctx: ResolveSourceCtx;
    direct: SourceResolution;
  } | undefined;

  // Extension commands bypass input hooks. This event resolves their references
  // under extension policy, independently of the current turn.
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
      for (const item of items) {
        const badge = item.kind === "file"
          ? theme.inverse(theme.fg("accent", " file "))
          : theme.inverse(theme.fg("bashMode", " bash "));
        const styledLabel = theme.fg("dim", ` ${item.label}`);
        const label = item.kind === "file" && item.path && getCapabilities().hyperlinks
          ? hyperlink(styledLabel, pathToFileURL(item.path).href)
          : styledLabel;
        let meta: string;
        if (item.result === "ok") {
          meta = theme.fg("dim", ` (${item.lines} line${item.lines !== 1 ? "s" : ""})`);
        } else {
          const statusBadge = item.result === "skipped" ? " ignored " : " error ";
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
    // sendUserMessage emits input too. Only explicit shared-resolver requests
    // may resolve extension content, even when its templates/skills are expanded.
    if (event.source === "extension") {
      pendingTurn = { input, source: "extension", ctx, direct: { attachments: [], inlines: [] } };
      return { action: "continue" };
    }
    const directConfig = cfgFor(settings, "userInput");
    const commands = directConfig.commands ? extractCommandRefs(input) : [];
    const showLoader = extensionCtx.hasUI && directConfig.display === "always" && commands.length > 0;
    let loader: Loader | undefined;
    let direct: SourceResolution;
    try {
      if (showLoader) {
        const label = commands.length === 1 ? commands[0]!.command : `${commands.length} commands`;
        extensionCtx.ui.setWidget("pi-resolve", (tui, theme) => {
          loader = new Loader(tui, (s) => theme.fg("bashMode", s), (s) => theme.fg("dim", s), ` ${label}`);
          loader.start();
          return loader;
        });
      }
      direct = await resolveSource(ctx, input, "userInput");
    } finally {
      loader?.stop();
      if (showLoader) extensionCtx.ui.setWidget("pi-resolve", undefined);
    }
    pendingTurn = { input, source: "userInput", ctx, direct };
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

    const prompt = event.prompt;
    const resolvePrompt = turn?.source === "userInput";
    const skill = resolvePrompt ? parseSkillBlock(prompt) : null;
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
    } else if (resolvePrompt && prompt !== input) {
      // Direct references retain their policy, even when disabled. Only newly
      // introduced references belong to the template.
      const expanded = maskDirectReferences(prompt, input ?? "");
      const resolved = await resolveSource(ctx, expanded, "template");
      allAttachments.push(...resolved.attachments);
      contextInlines.push(...resolved.inlines);
    }

    const allDisplayInlines = [...displayOnlyInlines, ...contextInlines];
    const hasContent = allAttachments.length > 0 || allDisplayInlines.length > 0;
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
    if (modifiedSystemPrompt) result.systemPrompt = modifiedSystemPrompt;

    if (hasContent) {
      // Successful system commands are already inlined. Failures retain their
      // literal reference there and also need explicit model-facing context.
      const content = [
        ...contextInlines,
        ...displayOnlyInlines.filter((item) => item.skipped || item.error),
        ...allAttachments,
      ].map((item) => ({ type: "text" as const, text: formatContext(item) }));
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
