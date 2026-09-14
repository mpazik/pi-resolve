import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createHarness, contextTexts } from "./session-harness.ts";

const files = {
  "note.md": "PROJECT_NOTE",
  "library/z.md": "CHILD_MUST_NOT_BE_READ",
  "library/a.md": "@secret.md",
  "library/nested/hidden.md": "NESTED_MUST_NOT_BE_READ",
  "secret.md": "SECRET_MUST_NOT_BE_ATTACHED",
};
const listing = '<file path="library/">\nDirectory listing (immediate entries):\na.md\nnested/\nz.md\n</file>';

test("typed prompts preserve text, attach once, keep imports inert, and persist across turns", async (t) => {
  const h = await createHarness(t, { persist: true, files: {
    ...files,
    "import.md": '@secret.md !`touch forbidden`',
    "output.txt": '@secret.md !`touch forbidden`',
  } });
  const prompt = '@note.md @./note.md @library/ @import.md !`printf x >> count; cat output.txt`\n`@secret.md`\n```\n@secret.md !`touch forbidden`\n```';
  const first = contextTexts(await h.prompt(prompt));
  assert.ok(first.includes(prompt));
  assert.equal(first.filter((text) => text.includes("PROJECT_NOTE")).length, 1);
  assert.ok(first.includes(listing));
  assert.ok(first.includes('<file path="import.md">\n@secret.md !`touch forbidden`\n</file>'));
  assert.ok(first.includes('<bash command="printf x >> count; cat output.txt">\n@secret.md !`touch forbidden`\n</bash>'));
  assert.doesNotMatch(first.join("\n"), /SECRET_MUST_NOT_BE_ATTACHED|CHILD_MUST_NOT_BE_READ|NESTED_MUST_NOT_BE_READ/);
  const second = contextTexts(await h.prompt('second !`printf x >> count; printf SECOND`'));
  assert.ok(second.includes(prompt));
  assert.equal(second.filter((text) => text.includes("PROJECT_NOTE")).length, 1);
  assert.equal(await readFile(join(h.cwd, "count"), "utf8"), "xx");
  await assert.rejects(readFile(join(h.cwd, "forbidden")), { code: "ENOENT" });
  const users = h.session.messages.filter((message) => message.role === "user");
  assert.deepEqual(users[0]?.content, [{ type: "text", text: prompt }]);
  const transcript = (await readFile(h.sessionManager.getSessionFile()!, "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line))
    .filter((entry) => entry.type === "message").map((entry) => entry.message);
  assert.deepEqual(transcript, JSON.parse(JSON.stringify(h.session.messages.filter((message) => message.role !== "custom"))));
  const restored = SessionManager.open(h.sessionManager.getSessionFile()!).buildSessionContext().messages;
  // Pi stamps custom transcript entries separately from in-memory messages.
  const withoutTimestamps = (messages: typeof restored) => JSON.parse(JSON.stringify(
    messages.map(({ timestamp: _timestamp, ...message }) => message),
  ));
  assert.deepEqual(withoutTimestamps(restored), withoutTimestamps(h.session.messages));
  assert.equal(restored.filter((message) => message.role === "custom").length, 2);
  assert.equal(transcript.filter((message) => message.role === "assistant").length, 2);
});

test("real skill expansion uses skill files, project commands, trailing args, and substitutions", async (t) => {
  const h = await createHarness(t, { files: {
    ...files,
    ".pi/skills/demo/SKILL.md": '---\nname: demo\ndescription: Resolver fixture\n---\n@note.md @library/ @arg-$0.md\n!`printf x >> skill-count; unset UNSET_FIXTURE; printf "%s" "$ARGUMENTS|$ARGUMENTS[0]|$0|$1|$9|${UNSET_FIXTURE:-fallback}"; pwd`',
    ".pi/skills/demo/note.md": "SKILL_NOTE",
    ".pi/skills/demo/arg-alpha.md": "SUBSTITUTED_FILE",
    ".pi/skills/demo/library/z.md": "CHILD_MUST_NOT_BE_READ",
    ".pi/skills/demo/library/a.md": "unused",
    ".pi/skills/demo/library/nested/hidden.md": "unused",
  } });
  assert.equal(h.resourceLoader.getSkills().skills[0]?.name, "demo");
  const texts = contextTexts(await h.prompt("/skill:demo alpha @note.md"));
  assert.ok(texts.includes('<file path="note.md">\nSKILL_NOTE\n</file>'));
  assert.ok(texts.includes('<file path="arg-alpha.md">\nSUBSTITUTED_FILE\n</file>'));
  assert.ok(texts.includes('<file path="note.md">\nPROJECT_NOTE\n</file>'));
  assert.ok(texts.includes(listing));
  assert.ok(texts.some((text) => text.includes(`alpha @note.md|alpha|alpha|@note.md||fallback${h.cwd}`)), texts.join("\n"));
  assert.equal(await readFile(join(h.cwd, "skill-count"), "utf8"), "x");
  assert.doesNotMatch(texts.join("\n"), /CHILD_MUST_NOT_BE_READ/);
});

test("loaded AGENTS context resolves once and command output stays inert", async (t) => {
  const h = await createHarness(t, { files: {
    ...files,
    "AGENTS.md": '@note.md @library/ !`printf x >> system-count; cat output.txt`',
    "output.txt": '@secret.md !`touch forbidden` SYSTEM_OUTPUT',
  } });
  assert.ok(h.resourceLoader.getAgentsFiles().agentsFiles.some((file) => file.path === join(h.cwd, "AGENTS.md")));
  const first = await h.prompt("first");
  assert.match(first.systemPrompt!, /SYSTEM_OUTPUT/);
  assert.ok(contextTexts(first).includes(listing));
  assert.doesNotMatch(contextTexts(first).join("\n"), /SECRET_MUST_NOT_BE_ATTACHED/);
  const second = await h.prompt("second");
  assert.match(second.systemPrompt!, /SYSTEM_OUTPUT/);
  assert.equal(contextTexts(second).filter((text) => text.includes("PROJECT_NOTE")).length, 1);
  assert.equal(await readFile(join(h.cwd, "system-count"), "utf8"), "x");
  await assert.rejects(readFile(join(h.cwd, "forbidden")), { code: "ENOENT" });
});

test("real prompt templates resolve files, directories and substituted commands under userInput policy", async (t) => {
  const h = await createHarness(t, { files: {
    ...files,
    ".pi/prompts/demo.md": '---\ndescription: Resolver fixture\n---\n@note.md @library/ !`printf x >> template-count; printf "$1"`',
  } });
  assert.equal(h.resourceLoader.getPrompts().prompts[0]?.name, "demo");
  const texts = contextTexts(await h.prompt("/demo TEMPLATE_OUTPUT"));
  assert.ok(texts.includes('<file path="note.md">\nPROJECT_NOTE\n</file>'));
  assert.ok(texts.includes(listing));
  assert.ok(texts.includes('<bash command="printf x >> template-count; printf "TEMPLATE_OUTPUT"">\nTEMPLATE_OUTPUT\n</bash>'));
  assert.equal(await readFile(join(h.cwd, "template-count"), "utf8"), "x");
});
