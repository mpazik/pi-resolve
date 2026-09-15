import assert from "node:assert/strict";
import { join } from "node:path";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piResolve, { RESOLVE_REFERENCES_EVENT, type ResolveReferencesRequest } from "../extensions/z-pi-resolve.ts";
import { createWorkspace } from "./workspace-harness.ts";

/** Lightweight extension host for shared-event contracts and controlled OS races.
 * Direct hook access is retained for loader and concurrency regression checks.
 * Prompt integration uses the real SDK session fixture instead.
 */
export function createResolverHarness(options: {
  maxTotalBytes?: number;
  mode?: "all" | "files";
} = {}) {
  const events = createEventBus();
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  piResolve({
    events,
    registerMessageRenderer() {},
    on(name: string, handler: (...args: any[]) => Promise<any>) { handlers.set(name, handler); },
  } as unknown as ExtensionAPI);
  let started = false;
  async function start(cwd: string) {
    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, { cwd });
    started = true;
  }
  return {
    handlers,
    start,
    async resolve(text: string, baseDir: string, mode = options.mode ?? "all") {
      if (!started) {
        await using workspace = await createWorkspace({
          prefix: "resolve-resource-settings-",
          files: { ".pi/pi-resolve.json": JSON.stringify({
            limits: { maxTotalBytes: options.maxTotalBytes ?? 1_000_000 },
            sources: { extension: { commands: true } },
          }) },
        });
        const previous = process.env.PI_CODING_AGENT_DIR;
        try {
          process.env.PI_CODING_AGENT_DIR = join(workspace.root, "agent");
          await start(workspace.root);
        } finally {
          if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
          else process.env.PI_CODING_AGENT_DIR = previous;
        }
      }
      const request: ResolveReferencesRequest = { version: 1, text, baseDir, mode };
      events.emit(RESOLVE_REFERENCES_EVENT, request);
      assert.ok(request.response);
      return await request.response;
    },
  };
}
