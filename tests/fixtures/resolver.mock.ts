import assert from "node:assert/strict";
import { join } from "node:path";
import fsPromises, { appendFile, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import { resolveSource, resolveReferencesForExtension, formatContext, type ResolveReferencesResult } from "../../src/resolver.ts";
import { mergeSettings, validateSettings, type Limits, type Source } from "../../src/settings.ts";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piResolve, { RESOLVE_REFERENCES_EVENT, type ResolveReferencesRequest } from "../../src/pi-resolve.ts";
import { createWorkspace, readFileEffects } from "./workspace.mock.ts";

export function nodeCommand(script: string) {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return `!\`${quote(process.execPath)} -e ${quote(script)}\``;
}

/** Resolver-owned capture uses real files and processes, without an extension host. */
export async function resolveShared(text: string, baseDir: string, limits: Partial<Limits> = {}) {
  return await resolveReferencesForExtension({ version: 1, text, baseDir }, mergeSettings({}, {
    limits, sources: { extension: { commands: true } },
  }));
}

export async function assertSharedResolution(input: {
  text: string; files?: Record<string, string>; limits?: Partial<Limits>;
}, expected: { context: string[]; statuses: string[]; files?: Record<string, string | null> }) {
  await using workspace = await createWorkspace({ files: input.files });
  const result = await resolveShared(input.text, workspace.root, input.limits);
  assert.deepEqual({ context: result.context, statuses: result.references.map(({ status }) => status),
    files: await readFileEffects(workspace.root, Object.keys(expected.files ?? {})),
  }, { ...expected, files: expected.files ?? {} });
}

export async function assertSourceContext(input: {
  text: string; files?: Record<string, string>; limits?: Partial<Limits>; source?: Source;
}, expected: { context: string[]; remaining: number; files?: Record<string, string | null> }) {
  await using workspace = await createWorkspace({ files: input.files });
  const settings = mergeSettings({}, validateSettings({ limits: input.limits ?? {} }).settings);
  const budget = { remaining: settings.limits.maxTotalBytes };
  const result = await resolveSource({ settings, budget, seenFiles: new Set(), cwd: workspace.root },
    input.text, input.source ?? "userInput");
  assert.deepEqual({ context: [...result.inlines, ...result.attachments].map(formatContext), remaining: budget.remaining,
    files: await readFileEffects(workspace.root, Object.keys(expected.files ?? {})),
  }, { ...expected, files: expected.files ?? {} });
}

export async function assertCommandCapture(input: { script: string }, expected: { output: string | null; status: string }) {
  const text = nodeCommand(input.script);
  await assertSharedResolution({ text }, {
    context: expected.output === null ? [] : [`<bash command="${text.slice(2, -1)}">\n${expected.output}\n</bash>`],
    statuses: [expected.status],
  });
}

export async function assertBatchConcurrency(input: { kind: "file" | "command"; count: number }, expected: {
  outputs: string[]; active: number; concurrent: boolean; withinLimit: boolean;
}, { t }: { t: TestContext }) {
  await using workspace = await createWorkspace();
  const { root } = workspace;
  const log = join(root, "events.jsonl");
  let active = 0;
  let peak = 0;
  let probe: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const refs = [];
    for (let index = 0; index < input.count; index++) {
      if (input.kind === "command") {
        refs.push(nodeCommand(`
          const fs = require("node:fs");
          fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({start: ${index}}) + "\\n");
          setTimeout(() => {
            fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({end: ${index}}) + "\\n");
            process.stdout.write(String(${index}));
          }, 150);
        `));
      } else {
        await writeFile(join(root, `file-${index}.txt`), String(index));
        refs.push(`@file-${index}.txt`);
      }
    }
    if (input.kind === "file") {
      probe = await open(join(root, "file-0.txt"));
      const prototype = Object.getPrototypeOf(probe);
      const originalRead = prototype.read;
      // Real descriptor I/O remains intact. Delay its completion to observe overlap.
      t.mock.method(prototype, "read", async function (this: typeof probe, ...args: unknown[]) {
        active++;
        peak = Math.max(peak, active);
        try { await delay(10); return await originalRead.apply(this, args); }
        finally { active--; }
      });
    }
    const result = await resolveShared(refs.join(" "), root);
    if (input.kind === "command") {
      for (const line of (await readFile(log, "utf8")).trim().split("\n")) {
        active += "start" in JSON.parse(line) ? 1 : -1;
        peak = Math.max(peak, active);
      }
    }
    assert.deepEqual({ outputs: result.context.map((text) => text.split("\n").at(-2)),
      active, concurrent: peak > 1, withinLimit: peak <= 4,
    }, expected);
  } finally {
    t.mock.restoreAll();
    await probe?.close();
  }
}

export async function assertDescendantCleanup(input: { ending: "timeout" | "normal exit" }, expected: {
  status: string; reason?: string; output: string[]; stopped: boolean; worked: boolean; ongoingWork: boolean;
}) {
  await using workspace = await createWorkspace({ files: {
    "worker.cjs": `
      const fs = require("node:fs");
      fs.appendFileSync("heartbeat", ".");
      fs.writeFileSync("worker.pid", String(process.pid));
      setInterval(() => fs.appendFileSync("heartbeat", "."), 10);
      setTimeout(() => process.exit(0), 20000);
    `,
  } });
  const { root } = workspace;
  const readPid = async (path: string) => {
    const pid = Number(await readFile(join(root, path), "utf8"));
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    return pid;
  };
  const cleanup = async () => {
    for (const [path, group] of [["shell.pid", true], ["worker.pid", false]] as const) {
      try { const pid = await readPid(path); process.kill(group ? -pid : pid, "SIGKILL"); }
      catch (error) {
        if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
  };
  const fallback = setTimeout(() => { void cleanup().catch(() => undefined); }, 12_000);
  try {
    const executable = `'${process.execPath.replaceAll("'", "'\\''")}'`;
    const result = await resolveShared(
      `!\`printf '%s' "$$" > shell.pid; ${executable} worker.cjs & while [ ! -s worker.pid ]; do sleep 0.01; done; ${input.ending === "timeout" ? "wait" : "printf done"}\``, root,
    );
    const pid = await readPid("worker.pid");
    const isStopped = () => {
      try { return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z"); }
      catch (error) { if ((error as { status?: number }).status === 1) return true; throw error; }
    };
    for (let attempts = 0; attempts < 100 && !isStopped(); attempts++) await delay(10);
    const heartbeat = await readFile(join(root, "heartbeat"), "utf8");
    await delay(150);
    assert.deepEqual({ status: result.references[0]?.status, reason: result.references[0]?.reason,
      output: result.context.map((text) => text.split("\n").at(-2)), stopped: isStopped(), worked: heartbeat.length > 0,
      ongoingWork: await readFile(join(root, "heartbeat"), "utf8") !== heartbeat,
    }, { reason: undefined, ...expected });
  } finally { clearTimeout(fallback); await cleanup(); }
}

export async function assertSpecialFiles(input: { fifo: string; text: string }, expected: { statuses: string[]; context: string[] }) {
  await using workspace = await createWorkspace();
  execFileSync("mkfifo", [join(workspace.root, input.fifo)]);
  const result = await resolveShared(input.text, workspace.root);
  assert.deepEqual({ statuses: result.references.map(({ status }) => status), context: result.context }, expected);
}

export async function assertFileReplacement(input: { path: string }, expected: {
  replaced: boolean; rescued: boolean; statuses: string[]; context: string[];
}, { t }: { t: TestContext }) {
  await using workspace = await createWorkspace({ files: { [input.path]: "regular before stat" } });
  const path = join(workspace.root, input.path);
  const originalStat = fsPromises.stat;
  let replaced = false;
  // No public seam exists for an atomic stat/open race. Preserve real OS operations.
  t.mock.method(fsPromises, "stat", async (...args: Parameters<typeof originalStat>) => {
    const stats = await originalStat(...args);
    if (args[0] === path && !replaced) {
      await rm(path); execFileSync("mkfifo", [path]); replaced = true;
    }
    return stats;
  });
  syncBuiltinESMExports();
  let rescued = false;
  const rescue = delay(1_000).then(async () => {
    rescued = true;
    return await open(path, constants.O_RDWR | constants.O_NONBLOCK);
  });
  try {
    const result = await resolveShared(`@${input.path}`, workspace.root);
    assert.deepEqual({ replaced, rescued, statuses: result.references.map(({ status }) => status), context: result.context }, expected);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports(); await (await rescue).close();
  }
}

export async function assertFileGrowth(input: { addedBytes: number }, expected: {
  statuses: string[]; context: string[]; requestedBytes: number;
}, { t }: { t: TestContext }) {
  await using workspace = await createWorkspace({ files: { "growing.txt": "small" } });
  const path = join(workspace.root, "growing.txt");
  await using probe = await open(path);
  const prototype = Object.getPrototypeOf(probe);
  const originalStat = prototype.stat;
  const originalRead = prototype.read;
  let requestedBytes = 0;
  let didGrow = false;
  t.mock.method(prototype, "stat", async function (this: typeof probe, ...args: unknown[]) {
    const result = await originalStat.apply(this, args);
    if (!didGrow) { didGrow = true; await appendFile(path, Buffer.alloc(input.addedBytes, 120)); }
    return result;
  });
  t.mock.method(prototype, "read", async function (this: typeof probe, ...args: [unknown, unknown, number, ...unknown[]]) {
    requestedBytes += args[2];
    return await originalRead.apply(this, args);
  });
  try {
    const result = await resolveShared("@growing.txt", workspace.root);
    assert.deepEqual({ statuses: result.references.map(({ status }) => status), context: result.context, requestedBytes }, expected);
  } finally { t.mock.restoreAll(); }
}

type EventReply = {
  context: string[];
  statuses: string[];
  reasons?: (string | undefined)[];
  outcomes?: Pick<ResolveReferencesResult["references"][number], "kind" | "reference" | "status">[];
  references?: ResolveReferencesResult["references"];
};

/** Exact context and ordered statuses are required. Full reference metadata fits API contract cases. */
export async function assertResolverEvents(input: {
  files?: Record<string, string>; directories?: string[]; project?: unknown;
  requests: { text: string; baseDir?: string; mode?: "all" | "files" }[];
}, expected: { replies: EventReply[]; files?: Record<string, string | null> }) {
  await using workspace = await createWorkspace({ files: {
    ...input.files, ".pi/pi-resolve.json": JSON.stringify(input.project ?? {}),
  } });
  for (const path of input.directories ?? []) await mkdir(join(workspace.root, path), { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = join(workspace.root, "agent");
    const harness = createResolverHarness();
    await harness.start(workspace.root);
    const replies = [];
    for (const [index, request] of input.requests.entries()) {
      const result = await harness.resolve(request.text, join(workspace.root, request.baseDir ?? ""), request.mode);
      replies.push({ context: result.context, statuses: result.references.map(({ status }) => status),
        ...(expected.replies[index]?.reasons && { reasons: result.references.map(({ reason }) => reason) }),
        ...(expected.replies[index]?.outcomes && { outcomes: result.references.map(({ kind, reference, status }) => ({ kind, reference, status })) }),
        ...(expected.replies[index]?.references && { references: result.references.map((reference) => ({ ...reference,
          ...(reference.resolvedPath && { resolvedPath: reference.resolvedPath.replaceAll(workspace.root, "<cwd>") }),
        })) }),
      });
    }
    assert.deepEqual({ replies, files: await readFileEffects(workspace.root, Object.keys(expected.files ?? {})) },
      { ...expected, files: expected.files ?? {} });
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

/** Lightweight extension host for shared-event contracts and loader UI.
 * Prompt integration uses the real SDK session fixture instead.
 */
export function createResolverHarness() {
  const events = createEventBus();
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  const renderers = new Map<string, Parameters<ExtensionAPI["registerMessageRenderer"]>[1]>();
  piResolve({
    events,
    registerMessageRenderer(name: string, renderer: Parameters<ExtensionAPI["registerMessageRenderer"]>[1]) {
      renderers.set(name, renderer);
    },
    on(name: string, handler: (...args: any[]) => Promise<any>) { handlers.set(name, handler); },
  } as unknown as ExtensionAPI);
  async function start(cwd: string) {
    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, { cwd });
  }
  return {
    handlers,
    renderers,
    start,
    async resolve(text: string, baseDir: string, mode: "all" | "files" = "all") {
      const request: ResolveReferencesRequest = { version: 1, text, baseDir, mode };
      events.emit(RESOLVE_REFERENCES_EVENT, request);
      assert.ok(request.response);
      return await request.response;
    },
  };
}
