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



const command = "printf 'run\\n' >> counter.txt; printf 'COMMAND_CONTEXT'";

const commandRef = `!\`${command}\``;

// README promises first-turn system resolution. Resume/reload command cache
// lifetime is not specified, so those cases deliberately use file context only.
test("new SDK session clears history and runs system commands once in each fresh session", async (t) => {
  const h = await createHarness(t, {
    persist: true,
    files: { "AGENTS.md": `@system.txt\n${commandRef}`, "system.txt": "SYSTEM_CONTEXT" },
  });
  const runtime = h.lifecycle();
  const firstId = h.sessionManager.getSessionId();
  const first = await h.prompt("FIRST_SESSION_ONLY");
  assert.ok(first.systemPrompt?.includes("COMMAND_CONTEXT"));
  assert.ok(contextTexts(first).some((text) => text.includes("SYSTEM_CONTEXT")));
  const second = await h.prompt("same session");
  assert.ok(second.systemPrompt?.includes("COMMAND_CONTEXT"));
  assert.equal(await readFile(join(h.cwd, "counter.txt"), "utf8"), "run\n");

  assert.deepEqual(await runtime.newSession(), { cancelled: false });
  assert.notEqual(h.sessionManager.getSessionId(), firstId);
  assert.deepEqual(h.session.messages, []);
  const fresh = await h.prompt("new session");
  assert.ok(!contextTexts(fresh).includes("FIRST_SESSION_ONLY"));
  assert.ok(fresh.systemPrompt?.includes("COMMAND_CONTEXT"));
  assert.ok(contextTexts(fresh).some((text) => text.includes("SYSTEM_CONTEXT")));
  await h.prompt("another fresh turn");
  assert.equal(await readFile(join(h.cwd, "counter.txt"), "utf8"), "run\nrun\n");
});

test("switching to a persisted session resumes context on the next real model turn without replaying user commands", async (t) => {
  const h = await createHarness(t, {
    persist: true, files: { "context.txt": "ORIGINAL_CONTEXT" },
  });
  const runtime = h.lifecycle();
  await h.prompt(`ORIGINAL_SESSION @context.txt ${commandRef}`);
  const originalPath = h.sessionManager.getSessionFile();
  assert.ok(originalPath);
  const originalId = h.sessionManager.getSessionId();
  assert.deepEqual(await runtime.newSession(), { cancelled: false });
  await h.prompt("OTHER_SESSION_ONLY");
  assert.deepEqual(await runtime.switchSession(originalPath), { cancelled: false });
  assert.equal(h.sessionManager.getSessionId(), originalId);
  await writeFile(join(h.cwd, "context.txt"), "UPDATED_CONTEXT");
  const resumed = await h.prompt("RESUMED_TURN @context.txt");
  const texts = contextTexts(resumed);
  assert.ok(texts.some((text) => text.includes("ORIGINAL_CONTEXT")));
  assert.ok(texts.some((text) => text.includes("UPDATED_CONTEXT")));
  assert.ok(texts.some((text) => text.includes("\nCOMMAND_CONTEXT\n")));
  assert.ok(!texts.includes("OTHER_SESSION_ONLY"));
  assert.equal(await readFile(join(h.cwd, "counter.txt"), "utf8"), "run\n");
});

test("SDK reload retains history and reloads resolver settings before the next model turn", async (t) => {
  const h = await createHarness(t, {
    persist: true,
    projectSettings: JSON.stringify({ sources: { userInput: { files: false } } }),
    files: { "context.txt": "AFTER_RELOAD_CONTEXT" },
  });
  const first = await h.prompt("BEFORE_RELOAD @context.txt");
  assert.ok(!contextTexts(first).some((text) => text.includes("AFTER_RELOAD_CONTEXT")));
  const id = h.sessionManager.getSessionId();
  await writeFile(join(h.cwd, ".pi/pi-resolve.json"), "{}");
  await h.session.reload();
  assert.equal(h.sessionManager.getSessionId(), id);
  const next = await h.prompt("AFTER_RELOAD @context.txt");
  assert.ok(contextTexts(next).includes("BEFORE_RELOAD @context.txt"));
  assert.ok(contextTexts(next).includes('<file path="context.txt">\nAFTER_RELOAD_CONTEXT\n</file>'));
  assert.deepEqual(h.resourceLoader.getExtensions().errors, []);
});
