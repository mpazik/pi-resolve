import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import fsPromises, { appendFile, open, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createResolverHarness } from "./fixtures/resolver.mock.ts";
import { createWorkspace } from "./fixtures/workspace.mock.ts";

function command(script: string) {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return `!\`${quote(process.execPath)} -e ${quote(script)}\``;
}

describe("Budget admission", () => {
  test("ordered batch admission discards excess outputs and never starts the next exhausted batch", async () => {
    await using workspace = await createWorkspace({ prefix: "resolve-batch-budget-" });
    const { root } = workspace;
    const commands = ["a", "b", "c", "d", "e"].map((name) => `printf x > ${name}; printf ${name}`);
    const expected = `<bash command="${commands[0]}">\na\n</bash>`;
    const result = await createResolverHarness({ maxTotalBytes: Buffer.byteLength(expected, "utf8") }).resolve(commands.map((cmd) => `!\`${cmd}\``).join(" "), root);
    assert.deepEqual(result.context, [expected]);
    assert.deepEqual(result.references.map(({ status }) => status), ["success", "oversized", "oversized", "oversized", "oversized"]);
    assert.deepEqual(await Promise.all(["a", "b", "c", "d"].map((name) => readFile(join(root, name), "utf8"))), ["x", "x", "x", "x"]);
    await assert.rejects(readFile(join(root, "e")), { code: "ENOENT" });
  });
});

describe("Command safety", () => {
  test("captures UTF-8 by bytes, preserving exact boundary output", { timeout: 5_000 }, async () => {
    const resolver = createResolverHarness();
    const accepted = await resolver.resolve(command('process.stdout.write("é".repeat(50000))'), process.cwd());
    assert.equal(accepted.references[0]?.status, "success");
    assert.ok(accepted.context[0]?.includes("é".repeat(50000)));
    const rejected = await resolver.resolve(command('process.stdout.write("é".repeat(50001))'), process.cwd());
    assert.equal(rejected.references[0]?.status, "oversized");
    assert.deepEqual(rejected.context, []);
  });

  for (const totalBytes of [100_000, 100_001]) {
    test(`combined stdout and stderr boundary: ${totalBytes} bytes`, { timeout: 5_000 }, async () => {
      const result = await createResolverHarness().resolve(command(`
        const fs = require("node:fs");
        fs.writeSync(1, "a".repeat(50000));
        fs.writeSync(2, "b".repeat(${totalBytes - 50_000}));
      `), process.cwd());
      assert.equal(result.references[0]?.status, totalBytes === 100_000 ? "success" : "oversized");
      if (totalBytes === 100_000) {
        assert.ok(result.context[0]?.endsWith(`\n${"a".repeat(50_000)}\n</bash>`));
      } else {
        assert.deepEqual(result.context, []);
      }
    });
  }

  for (const stream of ["stdout", "stderr"]) {
    test(`stops infinite ${stream} flooding`, { timeout: 5_000 }, async () => {
      const result = await createResolverHarness().resolve(command(`const fs = require("node:fs"); while (true) fs.writeSync(${stream === "stdout" ? 1 : 2}, "x".repeat(8192))`), process.cwd());
      assert.equal(result.references[0]?.status, "oversized");
      assert.deepEqual(result.context, []);
    });
  }

  test("limits command batch concurrency and retains output order", { timeout: 10_000 }, async () => {
    await using workspace = await createWorkspace({ prefix: "resolve-concurrency-" });
    const { root } = workspace;
    const log = join(root, "events.jsonl");
    const refs = Array.from({ length: 12 }, (_, index) => command(`
      const fs = require("node:fs");
      const path = ${JSON.stringify(log)};
      fs.appendFileSync(path, JSON.stringify({start: ${index}}) + "\\n");
      setTimeout(() => {
        fs.appendFileSync(path, JSON.stringify({end: ${index}}) + "\\n");
        process.stdout.write(String(${index}));
      }, 150);
    `));
    const resolver = createResolverHarness();
    await resolver.handlers.get("input")!({ text: refs.join(" ") }, { hasUI: false });
    const result = await resolver.handlers.get("before_agent_start")!({ prompt: refs.join(" "), systemPrompt: "" });
    const events = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    let active = 0;
    let peak = 0;
    for (const event of events) {
      active += "start" in event ? 1 : -1;
      peak = Math.max(peak, active);
    }
    assert.equal(active, 0);
    assert.ok(peak > 1 && peak <= 4, `peak concurrency: ${peak}`);
    assert.deepEqual(result.message.content.map((item: { text: string }) => item.text.split("\n").at(-2)), Array.from({ length: 12 }, (_, index) => String(index)));
  });

  for (const ending of ["timeout", "normal exit"] as const) {
    test(`cleans up descendant PID and stops work on ${ending}`, { timeout: 15_000, skip: process.platform === "win32" }, async () => {
      await using workspace = await createWorkspace({ prefix: "resolve-descendant-" });
      const { root } = workspace;
      const pidPath = join(root, "worker.pid");
      const shellPath = join(root, "shell.pid");
      const heartbeat = join(root, "heartbeat");
      const readPid = async (path: string) => {
        const pid = Number(await readFile(path, "utf8"));
        assert.ok(Number.isSafeInteger(pid) && pid > 1);
        return pid;
      };
      const cleanup = async () => {
        for (const [path, group] of [[shellPath, true], [pidPath, false]] as const) {
          try {
            const pid = await readPid(path);
            process.kill(group ? -pid : pid, "SIGKILL");
          } catch (error) {
            if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          }
        }
      };
      // Independent fallback also stops a broken resolver before the test deadline.
      const fallback = setTimeout(() => { void cleanup().catch(() => undefined); }, 12_000);
      try {
        await writeFile(join(root, "worker.cjs"), `
          const fs = require("node:fs");
          fs.appendFileSync("heartbeat", ".");
          fs.writeFileSync("worker.pid", String(process.pid));
          setInterval(() => fs.appendFileSync("heartbeat", "."), 10);
          setTimeout(() => process.exit(0), 20000);
        `);
        const executable = `'${process.execPath.replaceAll("'", "'\\''")}'`;
        const result = await createResolverHarness().resolve(
          `!\`printf '%s' "$$" > shell.pid; ${executable} worker.cjs & while [ ! -s worker.pid ]; do sleep 0.01; done; ${ending === "timeout" ? "wait" : "printf done"}\``,
          root,
        );
        assert.equal(result.references[0]?.status, ending === "timeout" ? "error" : "success");
        if (ending === "timeout") {
          assert.equal(result.references[0]?.reason, "command timed out or was killed");
        } else {
          assert.ok(result.context[0]?.endsWith("\ndone\n</bash>"));
        }
        const pid = await readPid(pidPath);
        const isStopped = () => {
          try {
            // An orphan may remain a zombie until the platform's reaper runs.
            return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z");
          } catch (error) {
            if ((error as { status?: number }).status === 1) return true;
            throw error;
          }
        };
        for (let attempts = 0; attempts < 100 && !isStopped(); attempts++) await delay(10);
        assert.ok(isStopped(), `descendant ${pid} is still running after ${ending}`);
        const stoppedHeartbeat = await readFile(heartbeat, "utf8");
        assert.ok(stoppedHeartbeat.length > 0, "descendant performed work before cleanup");
        await delay(150);
        assert.equal(await readFile(heartbeat, "utf8"), stoppedHeartbeat, "descendant must perform no ongoing work");
      } finally {
        clearTimeout(fallback);
        await cleanup();
      }
    });
  }
});

describe("Filesystem safety", () => {
  for (const totalBytes of [100_000, 100_001]) {
    test(`regular file boundary: ${totalBytes} bytes`, { timeout: 5_000 }, async () => {
      await using workspace = await createWorkspace({ prefix: "resolve-file-boundary-" });
      const { root } = workspace;
      const content = "a".repeat(totalBytes);
      await writeFile(join(root, "boundary.txt"), content);
      const result = await createResolverHarness().resolve("@boundary.txt", root);
      assert.equal(result.references[0]?.status, totalBytes === 100_000 ? "success" : "oversized");
      assert.deepEqual(result.context, totalBytes === 100_000 ? [`<file path="boundary.txt">\n${content}\n</file>`] : []);
    });
  }

  test("rejects FIFOs and devices without opening a blocking reader", { timeout: 3_000, skip: process.platform === "win32" }, async () => {
    await using workspace = await createWorkspace({ prefix: "resolve-special-" });
    const { root } = workspace;
    execFileSync("mkfifo", [join(root, "pipe.txt")]);
    const result = await createResolverHarness().resolve("@pipe.txt @/dev/zero @/dev/null", root);
    assert.deepEqual(result.references.map(item => item.status), ["error", "error", "error"]);
    assert.deepEqual(result.context, []);
  });

  test("rejects a regular file replaced by a FIFO between stat and open", { timeout: 5_000, skip: process.platform === "win32" }, async (t) => {
    await using workspace = await createWorkspace({ prefix: "resolve-fifo-race-" });
    const { root } = workspace;
    const path = join(root, "raced.txt");
    await writeFile(path, "regular before stat");
    const originalStat = fsPromises.stat;
    let replaced = false;
    t.mock.method(fsPromises, "stat", async (...args: Parameters<typeof originalStat>) => {
      const stats = await originalStat(...args);
      if (args[0] === path && !replaced) {
        await rm(path);
        execFileSync("mkfifo", [path]);
        replaced = true;
      }
      return stats;
    });
    syncBuiltinESMExports();
    // A regression to blocking open must fail safely, not strand a libuv worker.
    let rescued = false;
    const rescue = delay(1_000).then(async () => {
      rescued = true;
      return await open(path, constants.O_RDWR | constants.O_NONBLOCK);
    });
    try {
      const result = await createResolverHarness().resolve("@raced.txt", root);
      assert.ok(replaced, "replacement occurred after the initial regular-file stat");
      assert.equal(rescued, false, "resolver must finish without a FIFO writer");
      assert.equal(result.references[0]?.status, "error");
      assert.deepEqual(result.context, []);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await (await rescue).close();
    }
  });

  test("detects growth after descriptor stat with a bounded read", { timeout: 5_000 }, async (t) => {
    await using workspace = await createWorkspace({ prefix: "resolve-growth-" });
    const { root } = workspace;
    const path = join(root, "growing.txt");
    await writeFile(path, "small");
    const probe = await open(path);
    const prototype = Object.getPrototypeOf(probe);
    const originalStat = prototype.stat;
    const originalRead = prototype.read;
    let requestedBytes = 0;
    let didGrow = false;
    t.mock.method(prototype, "stat", async function (this: typeof probe, ...args: any[]) {
      const result = await originalStat.apply(this, args);
      if (!didGrow) {
        didGrow = true;
        await appendFile(path, Buffer.alloc(2_000_000, 120));
      }
      return result;
    });
    t.mock.method(prototype, "read", async function (this: typeof probe, ...args: any[]) {
      requestedBytes += args[2];
      return await originalRead.apply(this, args);
    });
    try {
      const result = await createResolverHarness().resolve("@growing.txt", root);
      assert.equal(result.references[0]?.status, "oversized");
      assert.deepEqual(result.context, []);
      assert.equal(requestedBytes, 100_001);
    } finally {
      t.mock.restoreAll();
      await probe.close();
    }
  });

  test("limits file batch concurrency", { timeout: 5_000 }, async (t) => {
    await using workspace = await createWorkspace({ prefix: "resolve-file-concurrency-" });
    const { root } = workspace;
    await Promise.all(Array.from({ length: 12 }, (_, index) => writeFile(join(root, `file-${index}.txt`), "content")));
    const probe = await open(join(root, "file-0.txt"));
    const prototype = Object.getPrototypeOf(probe);
    const originalRead = prototype.read;
    let active = 0;
    let peak = 0;
    t.mock.method(prototype, "read", async function (this: typeof probe, ...args: any[]) {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise(resolve => setTimeout(resolve, 10));
        return await originalRead.apply(this, args);
      } finally {
        active--;
      }
    });
    try {
      const result = await createResolverHarness().handlers.get("before_agent_start")!({
        prompt: Array.from({ length: 12 }, (_, index) => `@${join(root, `file-${index}.txt`)}`).join(" "),
        systemPrompt: "",
      });
      assert.equal(active, 0);
      assert.ok(peak > 1 && peak <= 4, `peak concurrency: ${peak}`);
      assert.equal(result.message.content.length, 12);
    } finally {
      t.mock.restoreAll();
      await probe.close();
    }
  });
});
