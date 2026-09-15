import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createResolverHarness } from "./fixtures/resolver.mock.ts";
import { createWorkspace, type WorkspaceFixture } from "./fixtures/workspace.mock.ts";

describe("Shared resolver", () => {
  let workspace: WorkspaceFixture;
  let root: string;
  let previousAgentDir: string | undefined;

  beforeEach(async () => {
    workspace = await createWorkspace({ prefix: "pi-resolve-event-" });
    root = workspace.root;
    // session_start must never load the developer's settings.
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  });

  afterEach(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await workspace[Symbol.asyncDispose]();
  });

  describe("Response contract", () => {
    test("returns ordered outcomes and inert imported content without running commands", async () => {
      const imported = "first file\n@nested.md !`echo nested`\n";
      await writeFile(join(root, "first.md"), imported);
      await writeFile(join(root, "nested.md"), "nested attachment must not appear");
      await writeFile(join(root, "last.md"), "last file\n");
      await writeFile(join(root, "large.md"), "é".repeat(50_001));
      await writeFile(join(root, "empty.md"), "");
      await mkdir(join(root, "directory"));
      const harness = createResolverHarness({ mode: "files" });
      await harness.start(root);

      const result = await harness.resolve(
        "@first.md then !`touch forbidden` then @missing.md, @large.md, @directory/, @empty.md, and @last.md",
        root,
      );

      await assert.rejects(readFile(join(root, "forbidden")), { code: "ENOENT" });
      assert.deepEqual(
        result.references.map(({ kind, reference, status }) => ({ kind, reference, status })),
        [
          { kind: "file", reference: "first.md", status: "success" },
          { kind: "command", reference: "touch forbidden", status: "disabled" },
          { kind: "file", reference: "missing.md", status: "missing" },
          { kind: "file", reference: "large.md", status: "oversized" },
          { kind: "file", reference: "directory/", status: "success" },
          { kind: "file", reference: "empty.md", status: "success" },
          { kind: "file", reference: "last.md", status: "success" },
        ],
      );
      assert.deepEqual(result.context, [
        `<file path="first.md">\n${imported}\n</file>`,
        '<file path="directory/">\nDirectory listing (immediate entries):\n(empty directory)\n</file>',
        '<file path="empty.md">\n\n</file>',
        '<file path="last.md">\nlast file\n\n</file>',
      ]);
      assert.equal(result.references[1]!.reason, "command execution is disabled in file-only mode");
      assert.equal(result.references[3]!.reason, "file exceeds 100000 bytes");
      assert.equal(result.references[4]!.reason, undefined);
      assert.deepEqual(
        result.references.filter(({ status }) => status === "success").map(({ context }) => context),
        result.context,
      );
    });

    test("uses canonical extensionless, escaped, inline and fenced matching relative to baseDir", async () => {
      const baseDir = join(root, "layer");
      await mkdir(join(baseDir, "src"), { recursive: true });
      await writeFile(join(baseDir, "src", "README"), "extensionless attachment");
      await writeFile(join(baseDir, "My Notes.md"), "escaped attachment");
      const harness = createResolverHarness({ mode: "files" });
      await harness.start(root);
      const text = [
        "Use @src/README then @./My\\ Notes.md",
        "```md",
        "@missing.md !`echo fenced`",
        "```",
        "`@inline.md` and ``@src/NOT_READ``",
        'import x from "@scope/package"',
        "user@example.com @todo node_modules/@scope/package",
      ].join("\n");

      const result = await harness.resolve(text, baseDir);
      assert.deepEqual(result.references, [
        {
          kind: "file",
          reference: "src/README",
          index: 4,
          resolvedPath: join(baseDir, "src", "README"),
          status: "success",
          context: '<file path="src/README">\nextensionless attachment\n</file>',
        },
        {
          kind: "file",
          reference: "./My Notes.md",
          index: 21,
          resolvedPath: join(baseDir, "My Notes.md"),
          status: "success",
          context: '<file path="./My Notes.md">\nescaped attachment\n</file>',
        },
      ]);
    });
  });

  describe("Directory listings", () => {
    test("lists sorted immediate entries without reading files or recursing", async () => {
      const directory = join(root, "library");
      await mkdir(join(directory, "nested"), { recursive: true });
      await writeFile(join(directory, "z.md"), "must not attach file contents");
      await writeFile(join(directory, "a.md"), "@missing.md !`touch forbidden`");
      await writeFile(join(directory, "nested", "hidden.md"), "must not recurse");
      const harness = createResolverHarness({ mode: "files" });
      await harness.start(root);

      const result = await harness.resolve("@library/ @./library", root);

      assert.deepEqual(result.references.map(({ status }) => status), ["success", "success"]);
      assert.deepEqual(result.context, [
        '<file path="library/">\nDirectory listing (immediate entries):\na.md\nnested/\nz.md\n</file>',
        '<file path="./library">\nDirectory listing (immediate entries):\na.md\nnested/\nz.md\n</file>',
      ]);
    });

    test("caps directory entries and reports omitted entries", async () => {
      await mkdir(join(root, "library"));
      for (let index = 0; index < 1_002; index++) {
        await writeFile(join(root, "library", `file-${String(index).padStart(4, "0")}`), "");
      }
      const harness = createResolverHarness({ mode: "files" });
      await harness.start(root);

      const result = await harness.resolve("@library/", root);

      assert.equal(result.references[0]!.status, "success");
      const lines = result.context[0]!.split("\n");
      assert.equal(lines.length, 1_004);
      assert.equal(lines[2], "file-0000");
      assert.equal(lines[1_001], "file-0999");
      assert.equal(lines[1_002], "[truncated: 2 entries omitted]");
    });

    test("caps listing bytes for long multibyte names",  async () => {
      await mkdir(join(root, "library"));
      for (let index = 0; index < 500; index++) {
        await writeFile(join(root, "library", `${String(index).padStart(4, "0")}-${"é".repeat(120)}`), "");
      }
      const harness = createResolverHarness({ mode: "files" });
      await harness.start(root);

      const result = await harness.resolve("@library/", root);

      assert.equal(result.references[0]!.status, "success");
      const content = result.context[0]!.split("\n").slice(1, -1).join("\n");
      assert.ok(Buffer.byteLength(content, "utf8") <= 100_000);
      assert.match(content, /\[truncated: \d+ entries omitted\]$/);
    });
  });

  describe("Caller policy", () => {
    test("shared commands are disabled by default without preventing files", async () => {
      await writeFile(join(root, "a.md"), "A");
      const harness = createResolverHarness({ mode: "files" });
      await harness.start(root);
      const result = await harness.resolve('@a.md !`touch forbidden`', root, "all");
      assert.deepEqual(result.references.map(({ status }) => status), ["success", "disabled"]);
      assert.deepEqual(result.context, ['<file path="a.md">\nA\n</file>']);
      await assert.rejects(readFile(join(root, "forbidden")), { code: "ENOENT" });
    });

    test("honors disabled file settings while file-only mode overrides enabled commands", async () => {
      await mkdir(join(root, ".pi"));
      await writeFile(
        join(root, ".pi", "pi-resolve.json"),
        JSON.stringify({ defaults: { files: false, commands: true } }),
      );
      await writeFile(join(root, "source.md"), "must not be included");
      const harness = createResolverHarness({ mode: "files" });
      await harness.start(root);

      const result = await harness.resolve("@source.md !`touch forbidden`", root);

      await assert.rejects(readFile(join(root, "forbidden")), { code: "ENOENT" });
      assert.deepEqual(result, {
        context: [],
        references: [
          {
            kind: "file",
            reference: "source.md",
            index: 0,
            status: "disabled",
            reason: "file resolution is disabled",
          },
          {
            kind: "command",
            reference: "touch forbidden",
            index: 11,
            status: "disabled",
            reason: "command execution is disabled in file-only mode",
          },
        ],
      });
    });
  });

  describe("Request budgets", () => {
    test("an empty file fits when only its wrapper fits the budget", async () => {
      await writeFile(join(root, "a.md"), "");
      const result = await createResolverHarness({ maxTotalBytes: 27 }).resolve("@a.md", root);
      assert.deepEqual(result, {
        context: ['<file path="a.md">\n\n</file>'],
        references: [{
          kind: "file", reference: "a.md", index: 0, status: "success",
          resolvedPath: join(root, "a.md"), context: '<file path="a.md">\n\n</file>',
        }],
      });
    });

    test("a silent command does not run when only its wrapper fits the budget", async () => {
      const result = await createResolverHarness({ maxTotalBytes: 41 }).resolve("!`touch forbidden`", root);
      assert.deepEqual(result, {
        context: [],
        references: [{
          kind: "command", reference: "touch forbidden", index: 0,
          status: "oversized", reason: "total byte budget exceeded",
        }],
      });
      await assert.rejects(readFile(join(root, "forbidden")), { code: "ENOENT" });
    });

    test("shared total includes UTF-8 wrappers, omits whole items and resets for each request", async () => {
      await mkdir(join(root, ".pi"));
      await writeFile(join(root, ".pi/pi-resolve.json"), JSON.stringify({ limits: { maxTotalBytes: 29 } }));
      await writeFile(join(root, "a.md"), "é");
      await writeFile(join(root, "b.md"), "B");
      const harness = createResolverHarness({ mode: "files" });
      await harness.start(root);
      const first = await harness.resolve("@a.md @b.md", root);
      assert.deepEqual(first.context, ['<file path="a.md">\né\n</file>']);
      assert.deepEqual(first.references.map(({ status }) => status), ["success", "oversized"]);
      assert.equal(first.references[1]!.reason, "total byte budget exceeded");
      assert.deepEqual((await harness.resolve("@b.md", root)).context, ['<file path="b.md">\nB\n</file>']);
    });

    test("shared byte failures consume no total and reference order decides admission", async () => {
      await mkdir(join(root, ".pi"));
      await writeFile(join(root, ".pi/pi-resolve.json"), JSON.stringify({
        limits: { maxFileBytes: 2, maxCommandBytes: 2, maxTotalBytes: 200 },
        sources: { extension: { commands: true } },
      }));
      await writeFile(join(root, "a.md"), "é");
      await writeFile(join(root, "large.md"), "éé");
      const harness = createResolverHarness({ mode: "files" });
      await harness.start(root);
      const result = await harness.resolve('@large.md !`printf é` @missing.md @a.md !`printf éé`', root, "all");
      assert.deepEqual(result.references.map(({ status }) => status), ["oversized", "success", "missing", "success", "oversized"]);
      assert.deepEqual(result.context, ['<bash command="printf é">\né\n</bash>', '<file path="a.md">\né\n</file>']);
    });

    test("exhausted shared budget does not start later commands", async () => {
      await mkdir(join(root, ".pi"));
      await writeFile(join(root, ".pi/pi-resolve.json"), JSON.stringify({
        limits: { maxTotalBytes: 28 }, sources: { extension: { commands: true } },
      }));
      await writeFile(join(root, "a.md"), "A");
      const harness = createResolverHarness({ mode: "files" });
      await harness.start(root);
      const result = await harness.resolve('@a.md !`touch forbidden`', root, "all");
      assert.deepEqual(result.references.map(({ status }) => status), ["success", "oversized"]);
      assert.equal(result.references[1]!.reason, "total byte budget exceeded");
      await assert.rejects(readFile(join(root, "forbidden")), { code: "ENOENT" });
    });
  });
});
