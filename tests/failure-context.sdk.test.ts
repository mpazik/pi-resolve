import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import consumerExtension from "./data/consumer-extension.ts";
import { createHarness, contextTexts } from "./session-harness.ts";
import { createResolverHarness } from "./resolver-harness.ts";



test("command timeout completes the turn and kills command side effects", { timeout: 20_000 }, async (t) => {
  const h = await createHarness(t);
  const texts = contextTexts(await h.prompt('!`printf x >> started; sleep 30; touch forbidden`'));
  assert.equal(await readFile(join(h.cwd, "started"), "utf8"), "x");
  await assert.rejects(readFile(join(h.cwd, "forbidden")), { code: "ENOENT" });
  assert.deepEqual(texts.filter((text) => text.startsWith("<bash ")), [
    '<bash command="printf x &gt;&gt; started; sleep 30; touch forbidden" status="error" reason="command failed" />',
  ]);
  const summary = h.session.messages.find((message) => message.role === "custom");
  assert.ok(summary?.role === "custom");
  assert.deepEqual((summary.details as { items: { result: string }[] }).items.map((item) => item.result), ["error"]);
});

test("oversized command output is skipped without entering provider context", async (t) => {
  const h = await createHarness(t);
  const request = await h.prompt('!`head -c 100001 /dev/zero | tr "\\0" x`');
  const markers = contextTexts(request).filter((text) => text.startsWith("<bash "));
  assert.equal(markers.length, 1);
  assert.match(markers[0]!, /status="oversized" reason="command output exceeds size limit" \/>$/);
  assert.doesNotMatch(markers[0]!, /x{100}/);
  const summary = h.session.messages.find((message) => message.role === "custom");
  assert.ok(summary?.role === "custom");
  assert.deepEqual((summary.details as { items: { result: string }[] }).items.map((item) => item.result), ["skipped"]);
});

for (const source of ["userInput", "systemPrompt", "skill", "template"] as const) {
  test(`${source}: failures reach the provider with display never and no captured payload`, async (t) => {
    t.mock.method(console, "error", () => {});
    const body = '@ok.md @missing.md @large.md @ok.md/child !`sh fail.sh` !`sh overflow.sh` !`printf SUCCESS`';
    const files = {
      "ok.md": "ORIGINAL_SUCCESS\n",
      "large.md": "PRIVATE_FILE_PAYLOAD".repeat(10_000),
    };
    const h = await createHarness(t, {
      projectSettings: JSON.stringify({ defaults: { display: "never" }, sources: { skill: { commands: true }, template: { commands: true } } }),
      files: {
        ...files,
        "fail.sh": "printf PRIVATE_STDOUT; printf PRIVATE_STDERR >&2; exit 7",
        "overflow.sh": "printf PRIVATE_OVERFLOW; head -c 100001 /dev/zero",
        ...(source === "systemPrompt" ? { "AGENTS.md": body } : {}),
        ...(source === "template" ? { ".pi/prompts/demo.md": body } : {}),
        ...(source === "skill" ? {
          ".pi/skills/demo/SKILL.md": `---\nname: demo\ndescription: fixture\n---\n${body}`,
          ".pi/skills/demo/ok.md": files["ok.md"],
          ".pi/skills/demo/large.md": files["large.md"],
        } : {}),
      },
    });
    const request = await h.prompt(source === "skill" ? "/skill:demo" : source === "template" ? "/demo" : source === "systemPrompt" ? "Check context" : body);
    const texts = contextTexts(request);
    assert.ok(texts.includes('<file path="ok.md">\nORIGINAL_SUCCESS\n\n</file>'));
    assert.deepEqual(texts.filter((text) => text.includes(' status="')).sort(), [
      '<file path="missing.md" status="missing" reason="file not found" />',
      '<file path="large.md" status="oversized" reason="file exceeds size limit" />',
      '<file path="ok.md/child" status="error" reason="unable to read file" />',
      '<bash command="sh fail.sh" status="error" reason="command failed" />',
      '<bash command="sh overflow.sh" status="oversized" reason="command output exceeds size limit" />',
    ].sort());
    assert.doesNotMatch(texts.join("\n"), /PRIVATE_|ENOTDIR|not a directory/);
    if (source === "systemPrompt") {
      assert.ok(request.systemPrompt?.includes('!`sh fail.sh`'));
      assert.ok(request.systemPrompt?.includes('!`sh overflow.sh`'));
      assert.ok(request.systemPrompt?.includes("SUCCESS"));
      assert.ok(!texts.some((text) => text.startsWith('<bash command="printf SUCCESS"')));
    } else {
      assert.ok(texts.includes('<bash command="printf SUCCESS">\nSUCCESS\n</bash>'));
    }
    const summary = h.session.messages.find((message) => message.role === "custom" && message.customType === "context");
    assert.ok(summary?.role === "custom");
    assert.deepEqual(summary.details, { items: [] });
  });
}
