import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { contextTexts } from "./session-harness.ts";

const exec = promisify(execFile);
const repo = dirname(dirname(fileURLToPath(import.meta.url)));

test("packed installation is discovered by the actual print CLI and reaches a completed provider request", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-resolve-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
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
  // Install the tarball without registry access or peer installation. Pi supplies
  // extension dependencies through its loader, as it does for published packages.
  await exec("npm", ["install", "--offline", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", join(root, filename)], {
    cwd: join(root, "install"), env, timeout: 20_000,
  });
  const installed = join(root, "install/node_modules/pi-resolve");
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.deepEqual(manifest.pi.extensions, ["./extensions/z-pi-resolve.ts"]);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [installed], retry: { enabled: false }, compaction: { enabled: false } }));
  await writeFile(join(cwd, "note.md"), "PACKED_CONTEXT");
  await mkdir(join(cwd, "library"));
  await writeFile(join(cwd, "library/z.md"), "DO_NOT_READ_CHILD");
  await writeFile(join(cwd, "library/a.md"), "DO_NOT_READ_CHILD");
  const capture = join(root, "request.jsonl");
  const cli = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")).replace(/index\.js$/, "cli.js");
  const running = exec(process.execPath, [cli,
    "--print", "--no-session", "--no-tools", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
    "--extension", join(repo, "tests/data/cli-provider.ts"),
    "--provider", "resolve-test", "--model", "faux-1",
    'Resolve @note.md @library/ !`printf x >> count; printf CLI_OUTPUT`',
  ], { cwd, env: { ...env, PI_RESOLVE_TEST_CAPTURE: capture }, timeout: 20_000 });
  running.child.stdin?.end();
  const result = await running;
  assert.equal(result.stdout.trim(), "OK");
  assert.doesNotMatch(result.stderr, /Error|Failed/i);
  const requests: Context[] = (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(requests.length, 1);
  const texts = contextTexts(requests[0]!);
  assert.ok(texts.includes('<file path="note.md">\nPACKED_CONTEXT\n</file>'));
  assert.ok(texts.includes('<file path="library/">\nDirectory listing (immediate entries):\na.md\nz.md\n</file>'));
  assert.ok(texts.includes('<bash command="printf x >> count; printf CLI_OUTPUT">\nCLI_OUTPUT\n</bash>'));
  assert.doesNotMatch(texts.join("\n"), /DO_NOT_READ_CHILD/);
  assert.equal(await readFile(join(cwd, "count"), "utf8"), "x");
});
