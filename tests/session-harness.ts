import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager, type ExtensionFactory, type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, InMemoryModelsStore,
  type Context, type FauxResponseStep,
} from "@earendil-works/pi-ai";
import piResolve from "../extensions/z-pi-resolve.ts";

/** Real SDK/resources/processes. Only the model response is synthetic. */
export async function createHarness(t: TestContext, options: {
  files?: Record<string, string>;
  globalSettings?: string;
  projectSettings?: string;
  extensions?: ExtensionFactory[];
  persist?: boolean;
} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-resolve-sdk-")));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const cleanup: (() => void)[] = [];
  t.after(async () => {
    try {
      for (const dispose of cleanup.reverse()) dispose();
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir);
  for (const [path, content] of Object.entries(options.files ?? {})) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content);
  }
  if (options.globalSettings !== undefined) await writeFile(join(agentDir, "pi-resolve.json"), options.globalSettings);
  if (options.projectSettings !== undefined) {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi/pi-resolve.json"), options.projectSettings);
  }
  const faux = fauxProvider({ tokensPerSecond: Infinity });
  const requests: Context[] = [];
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  cleanup.push(() => modelRuntime.unregisterProvider(faux.provider.id));
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false },
  });
  let theme: Theme | undefined;
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    extensionFactories: [piResolve, ...(options.extensions ?? []), (pi) => {
      pi.on("session_start", (_event, ctx) => { theme = ctx.ui.theme; });
    }],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const sessionManager = options.persist
    ? SessionManager.create(cwd, join(root, "sessions"))
    : SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({
    cwd, agentDir, modelRuntime, settingsManager,
    model: faux.getModel(), resourceLoader, sessionManager,
    noTools: "builtin",
  });
  cleanup.push(() => session.dispose());
  const errors: unknown[] = [];
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  t.after(() => assert.deepEqual(errors, [], "extension errors"));
  assert.ok(theme);
  function queue(response: FauxResponseStep = fauxAssistantMessage("OK")) {
    faux.appendResponses([async (context, options, state, model) => {
      requests.push({
        systemPrompt: context.systemPrompt,
        messages: structuredClone(context.messages),
        tools: context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters: structuredClone(parameters) })),
      });
      return typeof response === "function" ? response(context, options, state, model) : response;
    }]);
  }
  return {
    cwd, agentDir, session, sessionManager, resourceLoader, requests, queue, theme,
    async prompt(text: string) {
      queue();
      await session.prompt(text);
      const last = session.messages.at(-1);
      assert.equal(last?.role, "assistant");
      if (last?.role === "assistant") {
        assert.equal(last.stopReason, "stop", last.errorMessage ?? "turn must complete");
        assert.deepEqual(last.content, [{ type: "text", text: "OK" }]);
      }
      assert.equal(faux.getPendingResponseCount(), 0);
      return requests.at(-1)!;
    },
  };
}

export function contextTexts(context: Context): string[] {
  return context.messages.flatMap((message) => typeof message.content === "string"
    ? [message.content]
    : message.content.flatMap((block) => block.type === "text" ? [block.text] : []));
}
