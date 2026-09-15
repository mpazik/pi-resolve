import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { contextTexts } from "./fixtures/session.mock.ts";
import { createWorkspace } from "./fixtures/workspace.mock.ts";

const exec = promisify(execFile);
const repo = dirname(dirname(fileURLToPath(import.meta.url)));

test("packed extension installs and resolves file and shell context through the print CLI", { timeout: 60_000 }, async () => {
  await using workspace = await createWorkspace({ prefix: "pi-resolve-cli-" });
  const { root } = workspace;
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const home = join(root, "home");
  for (const path of [cwd, agentDir, home, join(root, "install")]) await mkdir(path, { recursive: true });
  // Allowlist environment: no inherited credentials, NODE_OPTIONS, or Pi config.
  const env = { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agentDir,
    npm_config_cache: join(root, "npm-cache"), npm_config_userconfig: join(root, "npmrc"),
    npm_config_globalconfig: join(root, "global-npmrc"), NO_COLOR: "1" };
  await writeFile(join(root, "npmrc"), "");
  await writeFile(join(root, "global-npmrc"), "");
  const packed = await exec("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], { cwd: repo, env, timeout: 20_000 });
  const [{ filename }] = JSON.parse(packed.stdout);
  // Offline installation leaves peer resolution to Pi's published-package loader.
  await exec("npm", ["install", "--offline", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", join(root, filename)], {
    cwd: join(root, "install"), env, timeout: 20_000,
  });
  const installed = join(root, "install/node_modules/pi-resolve");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [installed], retry: { enabled: false }, compaction: { enabled: false } }));
  await workspace.writeFiles({ "project/note.md": "PACKED_CONTEXT" });
  const capture = join(root, "request.jsonl");
  const piRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
  const piPackage = JSON.parse(await readFile(join(piRoot, "package.json"), "utf8"));
  const cli = join(piRoot, piPackage.bin.pi);
  // The extension runs through Pi's loader, which can support an older Node
  // than the native-TypeScript test runner. CI supplies that runtime explicitly.
  const running = exec(process.env.PI_RESOLVE_TEST_NODE ?? process.execPath, [cli,
    "--print", "--no-session", "--no-tools", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
    "--extension", join(repo, "tests/fixtures/provider.mock.ts"),
    "--provider", "resolve-test", "--model", "faux-1", "Resolve @note.md !`printf PACKED_SHELL`",
  ], { cwd, env: { ...env, PI_RESOLVE_TEST_CAPTURE: capture }, timeout: 20_000 });
  running.child.stdin?.end();
  const result = await running;
  const requests: Context[] = (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual({ stdout: result.stdout.trim(), requests: requests.map(contextTexts) }, {
    stdout: "OK",
    requests: [["Resolve @note.md !`printf PACKED_SHELL`", '<bash command="printf PACKED_SHELL">\nPACKED_SHELL\n</bash>', '<file path="note.md">\nPACKED_CONTEXT\n</file>']],
  });
});
