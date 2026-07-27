/**
 * In-process end-to-end test: verifies pi-resolve resolves @file and !`command`
 * references inside an expanded skill body.
 *
 * No subprocess, no network, no API key. We import pi as a library, register a
 * mock model provider, load the real pi-resolve extension plus a tiny capture
 * extension, then invoke `/skill:resolve-demo`. The capture extension records
 * the fully-assembled context the model *would* receive and aborts before any
 * provider call, so the assertions run against real resolution output.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import piResolve from "../extensions/z-pi-resolve.ts";

const here = dirname(fileURLToPath(import.meta.url));
const skillDir = join(here, "data", "skills", "resolve-demo");

test("skill: @file and !`command` are resolved into the model context", async () => {
  // Isolate from the developer's real ~/.pi config and project .pi config.
  const agentDir = mkdtempSync(join(tmpdir(), "pi-resolve-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-resolve-cwd-"));

  // Captured assembled context (JSON of all messages the model would see).
  let captured: string | undefined;

  const captureExtension = (pi: ExtensionAPI) => {
    pi.on("context", async (event, ctx) => {
      captured = JSON.stringify(event.messages);
      ctx.abort(); // stop before any real provider/network call
    });
  };

  // Mock provider/model: exists so a turn can start; never actually called.
  const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
  authStorage.setRuntimeApiKey("mock", "x");
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  modelRegistry.registerProvider("mock", {
    name: "Mock",
    baseUrl: "http://127.0.0.1:1", // unroutable; we abort before reaching it
    apiKey: "x",
    api: "anthropic-messages",
    models: [
      {
        id: "mock",
        name: "Mock",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 100,
      },
    ],
  });
  const model = modelRegistry.find("mock", "mock");
  assert.ok(model, "mock model should be registered");

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalSkillPaths: [skillDir],
    extensionFactories: [piResolve, captureExtension],
  });
  await resourceLoader.reload();

  // Sanity: the fixture skill was discovered under the expected name.
  const skillNames = resourceLoader.getSkills().skills.map((s) => s.name);
  assert.ok(
    skillNames.includes("resolve-demo"),
    `expected resolve-demo skill, got: ${skillNames.join(", ")}`,
  );

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    authStorage,
    modelRegistry,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
  });

  try {
    // prompt() resolves once the turn ends (aborted by the capture extension).
    await session.prompt("/skill:resolve-demo demo-arg").catch(() => {});

    const haystack = captured ?? JSON.stringify(session.messages);

    assert.match(
      haystack,
      /FIXTURE_FILE_RESOLVED_OK/,
      "@file reference inside the skill was not resolved",
    );
    assert.match(
      haystack,
      /<file path=\\?"fixture\.md\\?">/,
      "resolved file should be attached with its baseDir-relative path",
    );
    assert.match(
      haystack,
      /HELLO_FROM_SKILL_CMD/,
      "!`command` reference inside the skill was not resolved",
    );
  } finally {
    session.dispose();
  }
});
