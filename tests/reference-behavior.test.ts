import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createHarness, contextTexts } from "./fixtures/session.mock.ts";

test("escaped references stay literal while shell backticks reach sh unchanged", async (t) => {
  const h = await createHarness(t, { files: {
    "private.md": "MUST_NOT_BE_IMPORTED", "note.md": "NOTE",
  } });
  const prompt = '\\@private.md \\!`touch forbidden` @note.md !`printf "%s" "a\\`b"`';
  assert.deepEqual(contextTexts(await h.prompt(prompt)), [
    prompt,
    '<bash command="printf "%s" "a\\`b"">\na`b\n</bash>',
    '<file path="note.md">\nNOTE\n</file>',
  ]);
  await assert.rejects(readFile(join(h.cwd, "forbidden")), { code: "ENOENT" });
});

test("escaped system references stay literal on subsequent turns", async (t) => {
  const literal = '\\@private.md \\!`touch forbidden`';
  const h = await createHarness(t, { files: {
    "AGENTS.md": literal, "private.md": "MUST_NOT_BE_IMPORTED",
  } });
  const first = await h.prompt("first");
  const second = await h.prompt("second");
  assert.ok(first.systemPrompt?.includes(literal));
  assert.ok(second.systemPrompt?.includes(literal));
  assert.deepEqual(contextTexts(second), ["first", "OK", "second"]);
  assert.equal(h.session.messages.some((message) => message.role === "custom"), false);
  await assert.rejects(readFile(join(h.cwd, "forbidden")), { code: "ENOENT" });
});

test("template expansion preserves escaped argument references", async (t) => {
  const h = await createHarness(t, {
    files: {
      "private.md": "MUST_NOT_BE_IMPORTED",
      ".pi/prompts/demo.md": "$ARGUMENTS !`printf TEMPLATE`",
    },
    projectSettings: JSON.stringify({ sources: { template: { commands: true } } }),
  });
  const texts = contextTexts(await h.prompt('/demo \\@private.md \\!`touch forbidden`'));
  assert.deepEqual(texts, [
    '\\@private.md \\!`touch forbidden` !`printf TEMPLATE`',
    '<bash command="printf TEMPLATE">\nTEMPLATE\n</bash>',
  ]);
  await assert.rejects(readFile(join(h.cwd, "forbidden")), { code: "ENOENT" });
});

test("skill substitution preserves escaped argument references", async (t) => {
  const h = await createHarness(t, {
    files: {
      "private.md": "MUST_NOT_BE_IMPORTED",
      ".pi/skills/demo/private.md": "MUST_NOT_BE_IMPORTED",
      ".pi/skills/demo/SKILL.md": '---\nname: demo\ndescription: fixture\n---\n$ARGUMENTS !`printf SKILL`',
    },
    projectSettings: JSON.stringify({ sources: { skill: { commands: true } } }),
  });
  const request = await h.prompt('/skill:demo \\@private.md \\!`touch forbidden`');
  const imports = h.session.messages.filter((message) => message.role === "custom")
    .flatMap((message) => typeof message.content === "string" ? [message.content]
      : message.content.flatMap((block) => block.type === "text" ? [block.text] : []));
  assert.deepEqual(imports, ['<bash command="printf SKILL">\nSKILL\n</bash>']);
  assert.doesNotMatch(contextTexts(request).join("\n"), /MUST_NOT_BE_IMPORTED/);
  await assert.rejects(readFile(join(h.cwd, "forbidden")), { code: "ENOENT" });
});

test("project timeout overrides global settings for direct and system commands", { timeout: 5_000 }, async (t) => {
  const h = await createHarness(t, {
    globalSettings: JSON.stringify({ limits: { commandTimeoutMs: 20_000 } }),
    projectSettings: JSON.stringify({ limits: { commandTimeoutMs: 100 } }),
    files: { "AGENTS.md": '!`sleep 1; printf SYSTEM_LATE`' },
  });
  const prompt = '!`printf partial; sleep 1; printf DIRECT_LATE`';
  const request = await h.prompt(prompt);
  assert.deepEqual(contextTexts(request), [
    prompt,
    '<bash command="printf partial; sleep 1; printf DIRECT_LATE" status="error" reason="command failed" />',
    '<bash command="sleep 1; printf SYSTEM_LATE" status="error" reason="command failed" />',
  ]);
  assert.ok(request.systemPrompt?.includes('!`sleep 1; printf SYSTEM_LATE`'));
});

test("status rows render without extra leading or inter-item blank rows", async (t) => {
  const h = await createHarness(t, { files: { "note.md": "NOTE" } });
  await h.prompt('@note.md !`printf OK`');
  const summary = h.session.messages.find((message) => message.role === "custom" && message.customType === "context");
  assert.ok(summary?.role === "custom");
  const renderer = h.resourceLoader.getExtensions().extensions[0]?.messageRenderers.get("context");
  assert.ok(renderer);
  initTheme("dark", false);
  const component = renderer(summary, { expanded: false, outputPad: 0 }, h.theme);
  assert.ok(component);
  assert.deepEqual(component.render(200).map((line) => stripVTControlCharacters(line).trimEnd()), [
    " bash  printf OK (1 line)",
    " file  note.md (1 line)",
  ]);
});
