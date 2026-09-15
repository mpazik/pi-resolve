import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import consumerExtension from "./consumer-extension.mock.ts";
import { createHarness, contextTexts } from "./session.mock.ts";
import { readFileEffects } from "./workspace.mock.ts";

type Options = { t: TestContext };
type Harness = Awaited<ReturnType<typeof createHarness>>;
type SessionInput = NonNullable<Parameters<typeof createHarness>[1]> & { prompts: string[] };
type TurnExpected = {
  attachments: string[];
  /** SDK envelopes are outside the exact attachment contract. */
  textIncludes?: string[];
  textExcludes?: RegExp;
  systemIncludes?: string[];
  systemExcludes?: string[];
  summary?: { labels: string[]; display: boolean; results?: string[] };
};
type SessionExpected = {
  turns: TurnExpected[];
  files?: Record<string, string | null>;
  customMessages?: number;
};

function summaries(h: Harness) {
  return h.session.messages.filter((message) => message.role === "custom");
}

function readTurn(h: Harness, request: Context, expected: TurnExpected) {
  const normalize = (text: string) => text.replaceAll(h.cwd, "<cwd>");
  const texts = contextTexts(request).map(normalize);
  const system = normalize(request.systemPrompt ?? "");
  const summary = summaries(h).at(-1);
  if (expected.summary) {
    assert.ok(summary);
    assert.equal(summary.customType, "context", "latest custom message must be a context summary");
  }
  return {
    attachments: texts.filter((text) => /^<(file|bash) /.test(text)),
    ...(expected.textIncludes && { textIncludes: expected.textIncludes.map((text) => texts.includes(text)) }),
    ...(expected.textExcludes && { excludedTextPresent: expected.textExcludes.test(texts.join("\n")) }),
    ...(expected.systemIncludes && { systemIncludes: expected.systemIncludes.map((text) => system.includes(text)) }),
    ...(expected.systemExcludes && { systemExcludes: expected.systemExcludes.map((text) => system.includes(text)) }),
    ...(expected.summary && { summary: summary ? {
      labels: (summary.details as { items: { label: string }[] }).items.map(({ label }) => label),
      display: summary.display,
      ...(expected.summary.results && { results: (summary.details as { items: { result: string }[] }).items.map(({ result }) => result) }),
    } : null }),
  };
}

function expectedTurn(expected: TurnExpected) {
  return {
    attachments: expected.attachments,
    ...(expected.textIncludes && { textIncludes: expected.textIncludes.map(() => true) }),
    ...(expected.textExcludes && { excludedTextPresent: false }),
    ...(expected.systemIncludes && { systemIncludes: expected.systemIncludes.map(() => true) }),
    ...(expected.systemExcludes && { systemExcludes: expected.systemExcludes.map(() => false) }),
    ...(expected.summary && { summary: expected.summary }),
  };
}

async function readTurns(h: Harness, prompts: string[], expected: TurnExpected[]) {
  assert.equal(prompts.length, expected.length, "each prompt needs an expected turn");
  const turns = [];
  for (const [index, prompt] of prompts.entries()) {
    turns.push(readTurn(h, await h.prompt(prompt), expected[index]!));
  }
  return turns;
}

export async function assertSessionTurns(input: SessionInput, expected: SessionExpected, { t }: Options) {
  const h = await createHarness(t, input);
  assert.deepEqual({
    turns: await readTurns(h, input.prompts, expected.turns),
    files: await readFileEffects(h.cwd, Object.keys(expected.files ?? {})),
    ...(expected.customMessages !== undefined && { customMessages: summaries(h).length }),
  }, {
    turns: expected.turns.map(expectedTurn), files: expected.files ?? {},
    ...(expected.customMessages !== undefined && { customMessages: expected.customMessages }),
  });
}

export async function assertInjectedPrompt(input: NonNullable<Parameters<typeof createHarness>[1]> & {
  prompt: string; expandPromptTemplates?: boolean;
}, expected: { turn: TurnExpected; files: Record<string, string | null> }, { t }: Options) {
  const h = await createHarness(t, input);
  h.queue();
  // This is the same SDK boundary used by pi.sendUserMessage.
  await h.session.sendUserMessage(input.prompt, { expandPromptTemplates: input.expandPromptTemplates });
  assert.deepEqual({
    turn: readTurn(h, h.requests.at(-1)!, expected.turn),
    files: await readFileEffects(h.cwd, Object.keys(expected.files)),
  }, { turn: expectedTurn(expected.turn), files: expected.files });
}

export async function assertSourceResolution(input: {
  source: "userInput" | "systemPrompt" | "skill" | "template";
  body: string; files: Record<string, string>; projectSettings: string;
}, expected: SessionExpected, options: Options) {
  const { source, body, files, projectSettings } = input;
  await assertSessionTurns({
    projectSettings,
    files: {
      ...files,
      ...(source === "systemPrompt" ? { "AGENTS.md": body } : {}),
      ...(source === "template" ? { ".pi/prompts/demo.md": body } : {}),
      ...(source === "skill" ? {
        ...Object.fromEntries(Object.entries(files).map(([path, content]) => [`.pi/skills/demo/${path}`, content])),
        ".pi/skills/demo/SKILL.md": `---\nname: demo\ndescription: fixture\n---\n${body}`,
      } : {}),
    },
    prompts: [source === "skill" ? "/skill:demo" : source === "template" ? "/demo" : source === "systemPrompt" ? "Check context" : body],
  }, expected, options);
}

export async function assertPersistedTurns(input: SessionInput, expected: SessionExpected & {
  originalUserText: string; assistantMessages: number;
}, { t }: Options) {
  const h = await createHarness(t, { ...input, persist: true });
  const turns = await readTurns(h, input.prompts, expected.turns);
  const path = h.sessionManager.getSessionFile()!;
  const transcript = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    .filter((entry) => entry.type === "message").map((entry) => entry.message);
  const restored = SessionManager.open(path).buildSessionContext().messages;
  // SDK timestamps differ between custom transcript entries and memory.
  const withoutTimestamps = (messages: typeof restored) => JSON.parse(JSON.stringify(messages.map(({ timestamp: _, ...message }) => message)));
  assert.deepEqual({
    turns, files: await readFileEffects(h.cwd, Object.keys(expected.files ?? {})),
    originalUser: h.session.messages.find((message) => message.role === "user")?.content,
    transcript, restored: withoutTimestamps(restored),
    customMessages: restored.filter((message) => message.role === "custom").length,
    assistantMessages: transcript.filter((message: { role: string }) => message.role === "assistant").length,
  }, {
    turns: expected.turns.map(expectedTurn), files: expected.files ?? {},
    originalUser: [{ type: "text", text: expected.originalUserText }],
    transcript: JSON.parse(JSON.stringify(h.session.messages.filter((message) => message.role !== "custom"))),
    restored: withoutTimestamps(h.session.messages),
    customMessages: expected.customMessages, assistantMessages: expected.assistantMessages,
  });
}

// These helpers execute concrete SDK lifecycles, not a generic action language.
export async function assertNewSession(input: SessionInput & { freshPrompts: string[] }, expected: {
  turns: TurnExpected[]; filesBefore: Record<string, string | null>; filesAfter: Record<string, string | null>;
  replacement: { cancelled: boolean }; changedId: boolean; freshHistory: unknown[];
}, { t }: Options) {
  const h = await createHarness(t, { ...input, persist: true });
  const runtime = h.lifecycle();
  const id = h.sessionManager.getSessionId();
  const turns = await readTurns(h, input.prompts, expected.turns.slice(0, input.prompts.length));
  const filesBefore = await readFileEffects(h.cwd, Object.keys(expected.filesBefore));
  const replacement = await runtime.newSession();
  const changedId = h.sessionManager.getSessionId() !== id;
  const freshHistory = [...h.session.messages];
  turns.push(...await readTurns(h, input.freshPrompts, expected.turns.slice(input.prompts.length)));
  assert.deepEqual({ turns, filesBefore, filesAfter: await readFileEffects(h.cwd, Object.keys(expected.filesAfter)), replacement, changedId, freshHistory },
    { ...expected, turns: expected.turns.map(expectedTurn) });
}

export async function assertResumedSession(input: SessionInput & {
  otherPrompt: string; resumedPrompt: string; updatedFiles: Record<string, string>;
}, expected: {
  turn: TurnExpected; files: Record<string, string | null>; replacement: { cancelled: boolean };
  resumed: { cancelled: boolean }; restoredId: boolean;
}, { t }: Options) {
  const h = await createHarness(t, { ...input, persist: true });
  const runtime = h.lifecycle();
  for (const prompt of input.prompts) await h.prompt(prompt);
  const path = h.sessionManager.getSessionFile()!;
  const id = h.sessionManager.getSessionId();
  const replacement = await runtime.newSession();
  await h.prompt(input.otherPrompt);
  const resumed = await runtime.switchSession(path);
  const restoredId = h.sessionManager.getSessionId() === id;
  for (const [path, content] of Object.entries(input.updatedFiles)) await writeFile(join(h.cwd, path), content);
  const turn = readTurn(h, await h.prompt(input.resumedPrompt), expected.turn);
  assert.deepEqual({ turn, files: await readFileEffects(h.cwd, Object.keys(expected.files)), replacement, resumed, restoredId },
    { ...expected, turn: expectedTurn(expected.turn) });
}

export async function assertReloadedSession(input: SessionInput & { reloadedSettings: string; nextPrompt: string }, expected: {
  before: TurnExpected; after: TurnExpected; sameId: boolean; extensionErrors: unknown[];
}, { t }: Options) {
  const h = await createHarness(t, { ...input, persist: true });
  const before = readTurn(h, await h.prompt(input.prompts[0]!), expected.before);
  const id = h.sessionManager.getSessionId();
  await writeFile(join(h.cwd, ".pi/pi-resolve.json"), input.reloadedSettings);
  await h.session.reload();
  const sameId = h.sessionManager.getSessionId() === id;
  const after = readTurn(h, await h.prompt(input.nextPrompt), expected.after);
  assert.deepEqual({ before, after, sameId, extensionErrors: h.resourceLoader.getExtensions().errors },
    { ...expected, before: expectedTurn(expected.before), after: expectedTurn(expected.after) });
}

export async function assertExtensionConsumer(input: SessionInput, expected: {
  turn: TurnExpected; statuses: string[]; files: Record<string, string | null>; requests: number; messageRoles: string[];
}, { t }: Options) {
  const h = await createHarness(t, { ...input, extensions: [consumerExtension] });
  h.queue();
  await h.session.prompt(input.prompts[0]!);
  const request = h.requests[0]!;
  const references = JSON.parse(contextTexts(request).at(-1)!);
  assert.deepEqual({
    turn: readTurn(h, request, expected.turn), statuses: references.map((reference: { status: string }) => reference.status),
    files: await readFileEffects(h.cwd, Object.keys(expected.files)), requests: h.requests.length,
    messageRoles: h.session.messages.map((message) => message.role === "custom" ? message.customType : message.role),
  }, { ...expected, turn: expectedTurn(expected.turn) });
}

export async function assertToolConsumer(input: {
  files: Record<string, string>; projectSettings: string; text: string; mode: "all" | "files";
}, expected: { statuses: string[]; context: string[]; requests: number; customMessages: number; files: Record<string, string | null> }, { t }: Options) {
  const h = await createHarness(t, { ...input, extensions: [consumerExtension] });
  h.queue(fauxAssistantMessage(fauxToolCall("resolve_fixture", { text: input.text, mode: input.mode }), { stopReason: "toolUse" }));
  const request = await h.prompt("Use the fixture tool");
  const toolResult = request.messages.find((message) => message.role === "toolResult");
  assert.ok(toolResult?.role === "toolResult");
  const block = toolResult.content[0];
  assert.ok(block?.type === "text");
  const result = JSON.parse(block.text);
  const savedResult = h.session.messages.find((message) => message.role === "toolResult");
  assert.ok(savedResult?.role === "toolResult");
  assert.deepEqual({
    statuses: result.references.map((reference: { status: string }) => reference.status), context: result.context,
    requests: h.requests.length, customMessages: summaries(h).length, files: await readFileEffects(h.cwd, Object.keys(expected.files)),
    savedResult: savedResult.details,
  }, { ...expected, savedResult: result });
}

export async function assertRawTool(input: { files: Record<string, string>; prompt: string }, expected: {
  turn: TurnExpected; files: Record<string, string | null>; customMessages: number;
}, { t }: Options) {
  const h = await createHarness(t, { ...input, extensions: [consumerExtension] });
  h.queue(fauxAssistantMessage(fauxToolCall("raw_fixture", {}), { stopReason: "toolUse" }));
  const turn = readTurn(h, await h.prompt(input.prompt), expected.turn);
  assert.deepEqual({ turn, files: await readFileEffects(h.cwd, Object.keys(expected.files)), customMessages: summaries(h).length },
    { ...expected, turn: expectedTurn(expected.turn) });
}
