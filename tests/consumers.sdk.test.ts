import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import consumerExtension from "./data/consumer-extension.ts";
import { createHarness, contextTexts } from "./session-harness.ts";

const files = { "note.md": "CONSUMER_CONTENT", "secret.md": "MUST_NOT_ATTACH", "large.md": "x".repeat(100_001) };

test("extension command explicitly propagates extension-policy context and failures to its model call without resolver UI", async (t) => {
  const h = await createHarness(t, { files, extensions: [consumerExtension], projectSettings: JSON.stringify({ sources: {
    userInput: { files: false, commands: false }, extension: { display: "always" },
  } }) });
  h.queue();
  await h.session.prompt('/consumer @note.md @missing.md @large.md !`printf x >> consumer-count; printf COMMAND_OUTPUT` !`exit 8`');
  assert.equal(h.requests.length, 1);
  const texts = contextTexts(h.requests[0]!);
  assert.ok(texts.includes('<file path="note.md">\nCONSUMER_CONTENT\n</file>'));
  assert.ok(texts.some((text) => text.startsWith("<bash ") && text.includes("\nCOMMAND_OUTPUT\n")));
  const references = JSON.parse(texts.at(-1)!);
  assert.deepEqual(references.map((reference: { status: string }) => reference.status), ["success", "missing", "oversized", "success", "error"]);
  assert.equal(await readFile(join(h.cwd, "consumer-count"), "utf8"), "x");
  assert.deepEqual(h.session.messages.map((message) => message.role === "custom" ? message.customType : message.role), ["consumer-result"]);
});

for (const scenario of [
  { mode: "files", settings: { commands: true, files: true }, statuses: ["success", "disabled"] },
  { mode: "files", settings: { commands: true, files: false }, statuses: ["disabled", "disabled"] },
  { mode: "all", settings: { commands: false, files: false }, statuses: ["disabled", "disabled"] },
  { mode: "all", settings: { commands: true, files: true }, statuses: ["success", "success"] },
] as const) {
  test(`fixture tool propagates ${scenario.mode} outcomes with extension policy ${JSON.stringify(scenario.settings)}`, async (t) => {
    const h = await createHarness(t, { files, extensions: [consumerExtension], projectSettings: JSON.stringify({ sources: {
      userInput: { files: false, commands: false }, extension: { ...scenario.settings, display: "always" },
    } }) });
    h.queue(fauxAssistantMessage(fauxToolCall("resolve_fixture", {
      text: '@note.md !`printf x >> tool-count; printf TOOL_OUTPUT`', mode: scenario.mode,
    }), { stopReason: "toolUse" }));
    const request = await h.prompt("Use the fixture tool");
    const toolResult = request.messages.find((message) => message.role === "toolResult");
    assert.ok(toolResult?.role === "toolResult");
    const block = toolResult.content[0];
    assert.ok(block?.type === "text");
    const result = JSON.parse(block.text);
    assert.deepEqual(result.references.map((reference: { status: string }) => reference.status), scenario.statuses);
    assert.equal(result.context.length, scenario.statuses.filter((status) => status === "success").length);
    assert.equal(h.requests.length, 2);
    assert.equal(h.session.messages.filter((message) => message.role === "custom").length, 0);
    if (scenario.mode === "all" && scenario.settings.commands) {
      assert.equal(await readFile(join(h.cwd, "tool-count"), "utf8"), "x");
      assert.ok(result.context.includes('<file path="note.md">\nCONSUMER_CONTENT\n</file>'));
    } else await assert.rejects(readFile(join(h.cwd, "tool-count")), { code: "ENOENT" });
    const savedResult = h.session.messages.find((message) => message.role === "toolResult");
    assert.ok(savedResult?.role === "toolResult");
    assert.deepEqual(savedResult.details, result);
  });
}

test("arbitrary tool output stays inert with all resolver capabilities enabled", async (t) => {
  const h = await createHarness(t, { files, extensions: [consumerExtension] });
  h.queue(fauxAssistantMessage(fauxToolCall("raw_fixture", {}), { stopReason: "toolUse" }));
  const request = await h.prompt("Use the raw fixture tool");
  assert.ok(contextTexts(request).includes('@secret.md !`touch forbidden`'));
  assert.doesNotMatch(contextTexts(request).join("\n"), /MUST_NOT_ATTACH|<file path=|<bash command=/);
  await assert.rejects(readFile(join(h.cwd, "forbidden")), { code: "ENOENT" });
  assert.equal(h.session.messages.filter((message) => message.role === "custom").length, 0);
});
