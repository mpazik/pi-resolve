import { appendFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Test-only provider. Capture is opt-in and must contain synthetic context only. */
export default function (pi: ExtensionAPI) {
  const faux = fauxProvider({ provider: "resolve-test", tokensPerSecond: Infinity });
  faux.setResponses([(context) => {
    const path = process.env.PI_RESOLVE_TEST_CAPTURE;
    if (path) appendFileSync(path, JSON.stringify(context) + "\n", { mode: 0o600 });
    return fauxAssistantMessage("OK");
  }]);
  pi.registerProvider(faux.provider);
}
