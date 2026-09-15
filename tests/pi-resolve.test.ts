import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { createResolverHarness } from "./fixtures/resolver.mock.ts";
import { createWorkspace, readFileEffects } from "./fixtures/workspace.mock.ts";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";

type SummaryItem = { kind: string; label: string; path?: string; lines: number; result: string; message?: string };

async function assertSummary(input: {
  prompt: string; files: Record<string, string>; display?: "always" | "errors" | "never";
}, expected: { items: SummaryItem[]; rows: string[] | null }) {
  await using workspace = await createWorkspace({ files: {
    ...input.files,
    ".pi/pi-resolve.json": JSON.stringify({ defaults: { display: input.display ?? "always" } }),
  } });
  const resolver = createResolverHarness();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = join(workspace.root, "agent");
    await resolver.start(workspace.root);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  await resolver.handlers.get("input")!({ text: input.prompt }, { hasUI: false });
  const { message } = await resolver.handlers.get("before_agent_start")!({ prompt: input.prompt, systemPrompt: "" });
  assert.equal(message.customType, "context");
  const renderer = resolver.renderers.get(message.customType);
  assert.ok(renderer);
  // Test row content and spacing, not terminal color selection.
  const theme = { fg: (_color: string, text: string) => text, inverse: (text: string) => text } as Theme;
  const component = renderer(message, { expanded: false, outputPad: 0 }, theme);
  assert.deepEqual({
    items: message.details.items.map((item: SummaryItem) => ({
      ...item, ...(item.path && { path: item.path.replaceAll(workspace.root, "<cwd>") }),
    })),
    rows: component?.render(200).map((line) => stripVTControlCharacters(line).trimEnd()) ?? null,
  }, expected);
}

test("summary rows preserve command-first order, file paths, and empty and multiline counts", () =>
  assertSummary({ files: { "empty.md": "", "lines.md": "one\ntwo\n" },
    prompt: '@empty.md !`true` @lines.md !`printf "one\\ntwo\\n"`' }, {
    items: [
      { kind: "bash", label: "true", lines: 0, result: "ok", message: undefined },
      { kind: "bash", label: 'printf "one\\ntwo\\n"', lines: 2, result: "ok", message: undefined },
      { kind: "file", label: "empty.md", path: "<cwd>/empty.md", lines: 0, result: "ok", message: undefined },
      { kind: "file", label: "lines.md", path: "<cwd>/lines.md", lines: 3, result: "ok", message: undefined },
    ],
    rows: [' bash  true (0 lines)', ' bash  printf "one\\ntwo\\n" (2 lines)',
      ' file  empty.md (0 lines)', ' file  lines.md (3 lines)'],
  }));

test("error-only display renders failures and omissions without successful rows", () =>
  assertSummary({ files: { "ok.md": "OK", "large.md": "x".repeat(100_001) },
    prompt: '@ok.md !`exit 7` @large.md', display: "errors" }, {
    items: [
      { kind: "bash", label: "exit 7", lines: 0, result: "error", message: "exit code 7" },
      { kind: "file", label: "large.md", path: "<cwd>/large.md", lines: 0, result: "skipped", message: "too large" },
    ],
    rows: [' bash  exit 7  error  — exit code 7', ' file  large.md  ignored  — too large'],
  }));

test("error-only display creates no component for successful resolution", () =>
  assertSummary({ files: { "ok.md": "OK" }, prompt: '@ok.md', display: "errors" }, { items: [], rows: null }));

test("never display creates no component even for failures", () =>
  assertSummary({ files: {}, prompt: '@missing.md', display: "never" }, { items: [], rows: null }));

async function assertCommandLoader(input: { prompt: string }, expected: {
  widgets: string[]; renderedIncludes: string[]; redrawStarted: boolean; redrawStopped: boolean; content: string[];
}, { t }: { t: TestContext }) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  t.mock.method(console, "error", () => {});
  const resolver = createResolverHarness();
  const widgets: string[] = [];
  const rendered: string[] = [];
  let renders = 0;
  await resolver.handlers.get("input")!({ text: input.prompt }, {
    hasUI: true, ui: { setWidget: (name: string, widget?: (
      tui: { requestRender(): void }, theme: { fg(color: string, text: string): string },
    ) => { render(width: number): string[] }) => {
      widgets.push(`${name}:${typeof widget}`);
      if (widget) rendered.push(...widget({ requestRender: () => { renders++; } }, { fg: (_color, text) => text }).render(200));
    } },
  });
  const completedRenders = renders;
  t.mock.timers.tick(160);
  const result = await resolver.handlers.get("before_agent_start")!({ prompt: input.prompt, systemPrompt: "" });
  assert.deepEqual({ widgets, renderedIncludes: expected.renderedIncludes.map((text) => rendered.join("\n").includes(text)),
    redrawStarted: completedRenders > 0, redrawStopped: renders === completedRenders, content: result.message.content,
  }, { ...expected, renderedIncludes: expected.renderedIncludes.map(() => true), content: expected.content.map((text) => ({ type: "text", text })) });
}

async function assertLoadedPolicy(input: { global: string; project: string; text: string }, expected: {
  context: string[]; statuses: string[]; warnings: RegExp[]; files: Record<string, string | null>;
}, { t }: { t: TestContext }) {
  await using workspace = await createWorkspace({ files: {
    "agent/pi-resolve.json": input.global, ".pi/pi-resolve.json": input.project, "note.md": "NOTE",
  } });
  const previous = process.env.PI_CODING_AGENT_DIR;
  const warnings: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => warnings.push(args.join(" ")));
  try {
    process.env.PI_CODING_AGENT_DIR = join(workspace.root, "agent");
    const resolver = createResolverHarness();
    await resolver.start(workspace.root);
    const result = await resolver.resolve(input.text, workspace.root);
    assert.deepEqual({ context: result.context, statuses: result.references.map(({ status }) => status),
      warnings: warnings.map((warning, index) => expected.warnings[index]?.test(warning) ?? false),
      privateDiagnostic: /PRIVATE/.test(warnings.join("\n")),
      files: await readFileEffects(workspace.root, Object.keys(expected.files)),
    }, { ...expected, warnings: expected.warnings.map(() => true), privateDiagnostic: false });
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

describe("Command loader", () => {
  test("typed command loader is shown and cleared on successful resolution", async (t) =>
    assertCommandLoader({ prompt: "!`printf OK`" }, {
      widgets: ["pi-resolve:function", "pi-resolve:undefined"], renderedIncludes: ["printf OK"],
      redrawStarted: true, redrawStopped: true, content: ['<bash command="printf OK">\nOK\n</bash>'],
    }, { t }));

  test("typed command loader is cleared when command resolution fails", async (t) =>
    assertCommandLoader({ prompt: "!`exit 7`" }, {
      widgets: ["pi-resolve:function", "pi-resolve:undefined"], renderedIncludes: ["exit 7"],
      redrawStarted: true, redrawStopped: true, content: ['<bash command="exit 7" status="error" reason="command failed" />'],
    }, { t }));
});

describe("Settings loading", () => {
  test("malformed project JSON warns safely and retains non-default global capabilities", async (t) =>
    assertLoadedPolicy({ global: '{"sources":{"extension":{"files":false,"commands":true}}}', project: '{"PRIVATE_MALFORMED":',
      text: '@note.md !`printf x >> count; printf ALLOWED`' }, {
      context: ['<bash command="printf x >> count; printf ALLOWED">\nALLOWED\n</bash>'], statuses: ["disabled", "success"],
      warnings: [/Unable to read or parse/], files: { count: "x" },
    }, { t }));

  test("malformed global JSON and invalid project values warn without exposing their contents", async (t) =>
    assertLoadedPolicy({ global: '{"PRIVATE_MALFORMED":',
      project: '{"sources":{"extension":{"commands":"PRIVATE_INVALID"}},"PRIVATE_KEY":"PRIVATE_VALUE"}',
      text: '@note.md !`touch forbidden`' }, {
      context: ['<file path="note.md">\nNOTE\n</file>'], statuses: ["success", "disabled"],
      warnings: [/Unable to read or parse/, /invalid-value/, /unknown-key/], files: { forbidden: null },
    }, { t }));
});
