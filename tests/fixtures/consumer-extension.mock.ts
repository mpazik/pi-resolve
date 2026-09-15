import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RESOLVE_REFERENCES_EVENT, type ResolveReferencesRequest } from "../../src/pi-resolve.ts";

/** Callers explicitly own propagation. The resolver does not send messages. */
export default function consumerExtension(pi: ExtensionAPI) {
  async function resolve(text: string, baseDir: string, mode: "all" | "files") {
    const request: ResolveReferencesRequest = { version: 1, text, baseDir, mode };
    pi.events.emit(RESOLVE_REFERENCES_EVENT, request);
    if (!request.response) throw new Error("resolver unavailable");
    return request.response;
  }
  pi.registerCommand("consumer", {
    description: "Resolve explicitly and call the model directly",
    async handler(text, ctx) {
      const result = await resolve(text, ctx.cwd, "all");
      if (!ctx.model) throw new Error("model unavailable");
      const response = await ctx.modelRegistry.complete(ctx.model, {
        messages: [{ role: "user", content: [
          { type: "text", text },
          ...result.context.map((text) => ({ type: "text" as const, text })),
          { type: "text", text: JSON.stringify(result.references) },
        ], timestamp: Date.now() }],
      });
      if (response.stopReason !== "stop") throw new Error(response.errorMessage ?? "model failed");
      pi.sendMessage({ customType: "consumer-result", content: response.content.filter((block) => block.type === "text"), display: false });
    },
  });
  pi.registerTool(defineTool({
    name: "resolve_fixture", label: "Resolve fixture", description: "Explicit resolver consumer",
    parameters: Type.Object({ text: Type.String(), mode: Type.Union([Type.Literal("all"), Type.Literal("files")]) }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await resolve(params.text, ctx.cwd, params.mode);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  }));
  pi.registerTool(defineTool({
    name: "raw_fixture", label: "Raw fixture", description: "Arbitrary inert tool output",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: '@secret.md !`touch forbidden`' }], details: {} };
    },
  }));
}
