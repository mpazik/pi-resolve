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

const directoryFiles = {
  "docs/aaaaaaaaaaaaaaaaaaaa.md": "not imported",
  "docs/bbbbbbbbbbbbbbbbbbbb.md": "not imported",
  "docs/cccccccccccccccccccc.md": "not imported",
};

test("configured per-file limit preserves directory truncation with an omission count", async (t) => {
  const h = await createHarness(t, {
    projectSettings: JSON.stringify({ limits: { maxFileBytes: 100, maxTotalBytes: 1000 } }),
    files: directoryFiles,
  });
  const texts = contextTexts(await h.prompt("@docs/"));
  assert.ok(texts.includes('<file path="docs/">\nDirectory listing (immediate entries):\naaaaaaaaaaaaaaaaaaaa.md\n[truncated: 2 entries omitted]\n</file>'));
});

test("total budget omits a directory rather than further truncating its listing", async (t) => {
  const h = await createHarness(t, {
    projectSettings: JSON.stringify({ limits: { maxFileBytes: 200, maxTotalBytes: 110 } }),
    files: directoryFiles,
  });
  const texts = contextTexts(await h.prompt("@docs/"));
  assert.ok(texts.includes('<file path="docs/" status="oversized" reason="total byte budget exceeded" />'));
  assert.ok(!texts.some((text) => text.includes("Directory listing")));
});

test("turn total admits direct, system and template imports in order including wrappers", async (t) => {
  const h = await createHarness(t, {
    projectSettings: JSON.stringify({ limits: { maxTotalBytes: 59 } }),
    files: {
      "a.md": "A", "b.md": "B", "c.md": "C",
      "AGENTS.md": '!`printf SYS`',
      ".pi/prompts/demo.md": "@b.md @c.md",
    },
  });
  const request = await h.prompt("/demo @a.md");
  assert.ok(request.systemPrompt?.includes("SYS"));
  assert.deepEqual(contextTexts(request).filter((text) => text.startsWith("<file ")), [
    '<file path="a.md">\nA\n</file>',
    '<file path="b.md">\nB\n</file>',
    '<file path="c.md" status="oversized" reason="total byte budget exceeded" />',
  ]);
});

test("cached system output counts each turn without reexecution or redundant cache charges", async (t) => {
  const command = 'printf x >> count; printf SYS';
  const h = await createHarness(t, {
    projectSettings: JSON.stringify({ limits: { maxTotalBytes: 31 } }),
    files: { "a.md": "A", "big.md": "AB", "AGENTS.md": `!\`${command}\`` },
  });
  const first = await h.prompt("@a.md");
  assert.ok(first.systemPrompt?.includes("SYS"));
  assert.ok(!first.systemPrompt?.includes(`!\`${command}\``));
  const second = await h.prompt("@big.md");
  assert.ok(second.systemPrompt?.includes(`!\`${command}\``));
  assert.ok(contextTexts(second).includes('<bash command="printf x &gt;&gt; count; printf SYS" status="oversized" reason="total byte budget exceeded" />'));
  const third = await h.prompt("plain prompt");
  assert.ok(!third.systemPrompt?.includes(`!\`${command}\``));
  assert.equal(await readFile(join(h.cwd, "count"), "utf8"), "x");
});

test("file deduplication and failures do not consume successful payload capacity", async (t) => {
  const h = await createHarness(t, {
    projectSettings: JSON.stringify({ limits: { maxFileBytes: 2, maxTotalBytes: 56 } }),
    files: { "a.md": "A", "b.md": "B", "large.md": "XXX" },
  });
  const texts = contextTexts(await h.prompt("@large.md @missing.md @a.md @./a.md @b.md"));
  assert.deepEqual(texts.filter((text) => text.startsWith("<file ")), [
    '<file path="large.md" status="oversized" reason="file exceeds size limit" />',
    '<file path="missing.md" status="missing" reason="file not found" />',
    '<file path="a.md">\nA\n</file>',
    '<file path="b.md">\nB\n</file>',
  ]);
});

test("turn budget omits commands that cannot fit without starting their side effects", async (t) => {
  const h = await createHarness(t, {
    projectSettings: JSON.stringify({ limits: { maxTotalBytes: 28 } }),
    files: { "a.md": "A" },
  });
  const texts = contextTexts(await h.prompt('@a.md !`touch forbidden`'));
  assert.ok(texts.includes('<bash command="touch forbidden" status="oversized" reason="total byte budget exceeded" />'));
  await assert.rejects(readFile(join(h.cwd, "forbidden")), { code: "ENOENT" });
});

test("skill imports share the direct and system budget and omitted commands never start", async (t) => {
  const h = await createHarness(t, {
    projectSettings: JSON.stringify({ limits: { maxTotalBytes: 59 }, sources: { skill: { commands: true } } }),
    files: {
      "a.md": "A", "AGENTS.md": '!`printf SYS`',
      ".pi/skills/demo/SKILL.md": '---\nname: demo\ndescription: fixture\n---\n@b.md !`touch forbidden`',
      ".pi/skills/demo/b.md": "B",
    },
  });
  const texts = contextTexts(await h.prompt("/skill:demo @a.md"));
  assert.ok(texts.includes('<file path="a.md">\nA\n</file>'));
  assert.ok(texts.includes('<file path="b.md">\nB\n</file>'));
  assert.ok(texts.includes('<bash command="touch forbidden" status="oversized" reason="total byte budget exceeded" />'));
  await assert.rejects(readFile(join(h.cwd, "forbidden")), { code: "ENOENT" });
});

test("safe-integer limits read small files without allocating the configured capacity", async (t) => {
  const h = await createHarness(t, {
    projectSettings: JSON.stringify({ limits: { maxFileBytes: Number.MAX_SAFE_INTEGER, maxTotalBytes: Number.MAX_SAFE_INTEGER } }),
    files: { "a.md": "A" },
  });
  assert.ok(contextTexts(await h.prompt("@a.md")).includes('<file path="a.md">\nA\n</file>'));
});

test("tiny budgets still report safe explicitly shortened failure references", async (t) => {
  const h = await createHarness(t, { projectSettings: JSON.stringify({ limits: { maxTotalBytes: 1 } }) });
  const texts = contextTexts(await h.prompt(`!\`printf ${"x".repeat(2000)}\``));
  const markers = texts.filter((text) => text.startsWith("<bash "));
  assert.equal(markers.length, 1);
  assert.match(markers[0]!, /\[reference shortened\].*reason="total byte budget exceeded"/);
  assert.ok(Buffer.byteLength(markers[0]!, "utf8") < 400);
});
