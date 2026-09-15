import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assertSourceContext, assertSharedResolution, assertCommandCapture, assertResolverEvents,
  assertBatchConcurrency, assertDescendantCleanup, assertSpecialFiles, assertFileReplacement, assertFileGrowth,
} from "./fixtures/resolver.mock.ts";
import { formatContext } from "../src/resolver.ts";

const directoryFiles = {
  "docs/aaaaaaaaaaaaaaaaaaaa.md": "not imported",
  "docs/bbbbbbbbbbbbbbbbbbbb.md": "not imported",
  "docs/cccccccccccccccccccc.md": "not imported",
};

describe("Source resolution", () => {
  test("imported files and command output remain inert at the source boundary", async () =>
    assertSourceContext(
      { text: '!`cat output.txt` @import.md', files: {
        "output.txt": '@secret.md !`touch forbidden`', "import.md": '@secret.md !`touch forbidden`', "secret.md": "PRIVATE",
      }, limits: { maxTotalBytes: 200 } },
      { context: ['<bash command="cat output.txt">\n@secret.md !`touch forbidden`\n</bash>',
        '<file path="import.md">\n@secret.md !`touch forbidden`\n</file>'], remaining: 70, files: { forbidden: null } },
    ));

  test("canonical duplicate files and failures leave capacity for distinct successful files", async () =>
    assertSourceContext(
      { text: "@large.md @missing.md @a.md @./a.md @b.md", files: { "a.md": "A", "b.md": "B", "large.md": "XXX" },
        limits: { maxFileBytes: 2, maxTotalBytes: 56 } },
      { context: [
        '<file path="large.md" status="oversized" reason="file exceeds size limit" />',
        '<file path="missing.md" status="missing" reason="file not found" />',
        '<file path="a.md">\nA\n</file>', '<file path="b.md">\nB\n</file>',
      ], remaining: 0 },
    ));

  test("shared requests deliberately retain canonical duplicate references", async () =>
    assertResolverEvents({ files: { "a.md": "A" }, requests: [{ text: "@a.md @./a.md" }] },
      { replies: [{ context: ['<file path="a.md">\nA\n</file>', '<file path="./a.md">\nA\n</file>'], statuses: ["success", "success"] }] }));

  test("per-file limits truncate directories with an exact omission count", async () =>
    assertSourceContext(
      { text: "@docs/", files: directoryFiles, limits: { maxFileBytes: 100, maxTotalBytes: 1000 } },
      { context: ['<file path="docs/">\nDirectory listing (immediate entries):\naaaaaaaaaaaaaaaaaaaa.md\n[truncated: 2 entries omitted]\n</file>'], remaining: 879 },
    ));

  test("total capacity omits directories without further truncating their listing", async () =>
    assertSourceContext(
      { text: "@docs/", files: directoryFiles, limits: { maxFileBytes: 200, maxTotalBytes: 110 } },
      { context: ['<file path="docs/" status="oversized" reason="total byte budget exceeded" />'], remaining: 110 },
    ));

  test("safe-integer capacities read small files without allocating the configured limit", async () =>
    assertSourceContext(
      { text: "@a.md", files: { "a.md": "A" }, limits: { maxFileBytes: Number.MAX_SAFE_INTEGER, maxTotalBytes: Number.MAX_SAFE_INTEGER } },
      { context: ['<file path="a.md">\nA\n</file>'], remaining: Number.MAX_SAFE_INTEGER - 28 },
    ));
});

describe("Context formatting", () => {
  test("successful imported content remains verbatim rather than recursively interpreted", () =>
    assert.equal(formatContext({ kind: "file", source: "userInput", resolvedPath: "/note.md", displayPath: "note.md",
      content: '@other.md !`touch forbidden`\n' }), '<file path="note.md">\n@other.md !`touch forbidden`\n\n</file>'));

  test("command failures escape reference attributes and omit private output and error details", () =>
    assert.equal(formatContext({ kind: "bash", source: "userInput", command: 'echo "<&>"\r\nnext',
      output: "PRIVATE_OUTPUT", error: "PRIVATE_ERROR" }),
      '<bash command="echo &quot;&lt;&amp;&gt;&quot;&#13;&#10;next" status="error" reason="command failed" />'));

  test("oversized command markers discard captured output", () =>
    assert.equal(formatContext({ kind: "bash", source: "userInput", command: "printf big", output: "PRIVATE", skipped: true }),
      '<bash command="printf big" status="oversized" reason="command output exceeds size limit" />'));

  test("long failure references are explicitly shortened even when total capacity is exhausted", () =>
    assert.equal(formatContext({ kind: "bash", source: "userInput", command: `printf ${"x".repeat(2000)}`,
      output: "PRIVATE", skipped: true, budgetExceeded: true }),
      `<bash command="printf ${"x".repeat(153)} [reference shortened]" status="oversized" reason="total byte budget exceeded" />`));

  test("operational file errors expose only a safe reason", () =>
    assert.equal(formatContext({ kind: "file", source: "skill", displayPath: 'a"&<.md', resolvedPath: "/private/path",
      content: "PRIVATE", error: "PRIVATE_ENOTDIR", errorCode: "ENOTDIR" }),
      '<file path="a&quot;&amp;&lt;.md" status="error" reason="unable to read file" />'));
});

// resolver.ts owns capture, batching and process cleanup. There is no executor module.
describe("Command capture and batching", () => {
  test("UTF-8 output exactly at the byte limit is retained", { timeout: 5000 }, async () =>
    assertCommandCapture({ script: 'process.stdout.write("é".repeat(50000))' }, { output: "é".repeat(50000), status: "success" }));

  test("UTF-8 output above the byte limit is discarded whole", { timeout: 5000 }, async () =>
    assertCommandCapture({ script: 'process.stdout.write("é".repeat(50001))' }, { output: null, status: "oversized" }));

  test("combined stdout and stderr exactly at the limit admits stdout only", { timeout: 5000 }, async () =>
    assertCommandCapture({ script: 'const fs = require("node:fs"); fs.writeSync(1, "a".repeat(50000)); fs.writeSync(2, "b".repeat(50000));' },
      { output: "a".repeat(50000), status: "success" }));

  test("stderr consumes capacity even when stdout alone would fit", { timeout: 5000 }, async () =>
    assertCommandCapture({ script: 'const fs = require("node:fs"); fs.writeSync(1, "a".repeat(50000)); fs.writeSync(2, "b".repeat(50001));' },
      { output: null, status: "oversized" }));

  test("infinite stdout flooding settles without retaining output", { timeout: 5000 }, async () =>
    assertCommandCapture({ script: 'const fs = require("node:fs"); while (true) fs.writeSync(1, "x".repeat(8192))' },
      { output: null, status: "oversized" }));

  test("infinite stderr flooding settles without retaining output", { timeout: 5000 }, async () =>
    assertCommandCapture({ script: 'const fs = require("node:fs"); while (true) fs.writeSync(2, "x".repeat(8192))' },
      { output: null, status: "oversized" }));

  test("active batch side effects finish but exhausted later batches never start", async () =>
    assertSharedResolution(
      { text: '!`printf x > a; printf a` !`printf x > b; printf b` !`printf x > c; printf c` !`printf x > d; printf d` !`printf x > e; printf e`',
        limits: { maxTotalBytes: 49 } },
      { context: ['<bash command="printf x > a; printf a">\na\n</bash>'],
        statuses: ["success", "oversized", "oversized", "oversized", "oversized"], files: { a: "x", b: "x", c: "x", d: "x", e: null } },
    ));

  test("parallel commands are capped at four and returned in reference order", { timeout: 10000 }, async (t) =>
    assertBatchConcurrency({ kind: "command", count: 12 },
      { outputs: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"], active: 0, concurrent: true, withinLimit: true }, { t }));

  test("timeout kills descendants and stops their ongoing work", { timeout: 15000, skip: process.platform === "win32" }, async () =>
    assertDescendantCleanup({ ending: "timeout" },
      { status: "error", reason: "command timed out or was killed", output: [], stopped: true, worked: true, ongoingWork: false }));

  test("normal shell exit also kills descendants and stops their ongoing work", { timeout: 15000, skip: process.platform === "win32" }, async () =>
    assertDescendantCleanup({ ending: "normal exit" },
      { status: "success", output: ["done"], stopped: true, worked: true, ongoingWork: false }));
});

describe("File capture", () => {
  test("regular files exactly at the byte limit are retained", async () =>
    assertSharedResolution({ text: "@boundary.txt", files: { "boundary.txt": "a".repeat(100000) } },
      { context: [`<file path="boundary.txt">\n${"a".repeat(100000)}\n</file>`], statuses: ["success"] }));

  test("regular files one byte over the limit are discarded", async () =>
    assertSharedResolution({ text: "@boundary.txt", files: { "boundary.txt": "a".repeat(100001) } },
      { context: [], statuses: ["oversized"] }));

  test("FIFOs and devices are rejected without blocking readers", { timeout: 3000, skip: process.platform === "win32" }, async () =>
    assertSpecialFiles({ fifo: "pipe.txt", text: "@pipe.txt @/dev/zero @/dev/null" }, { statuses: ["error", "error", "error"], context: [] }));

  test("a regular file replaced by a FIFO after stat cannot block open", { timeout: 5000, skip: process.platform === "win32" }, async (t) =>
    assertFileReplacement({ path: "raced.txt" }, { replaced: true, rescued: false, statuses: ["error"], context: [] }, { t }));

  test("growth after descriptor stat is rejected with a bounded sentinel read", { timeout: 5000 }, async (t) =>
    assertFileGrowth({ addedBytes: 2000000 }, { statuses: ["oversized"], context: [], requestedBytes: 100001 }, { t }));

  test("parallel file reads are capped at four without losing or reordering results", { timeout: 5000 }, async (t) =>
    assertBatchConcurrency({ kind: "file", count: 12 },
      { outputs: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"], active: 0, concurrent: true, withinLimit: true }, { t }));
});

describe("Shared response contract", () => {
  test("shared outcomes stay in reference order and successful empty payloads remain present", async () =>
    assertResolverEvents({
      files: { "first.md": "first file\n@nested.md !`echo nested`\n", "nested.md": "PRIVATE", "last.md": "last file\n",
        "large.md": "é".repeat(50001), "empty.md": "" }, directories: ["directory"],
      requests: [{ text: '@first.md then !`touch forbidden` then @missing.md, @large.md, @directory/, @empty.md, and @last.md', mode: "files" }],
    }, { replies: [{ statuses: ["success", "disabled", "missing", "oversized", "success", "success", "success"], context: [
      '<file path="first.md">\nfirst file\n@nested.md !`echo nested`\n\n</file>',
      '<file path="directory/">\nDirectory listing (immediate entries):\n(empty directory)\n</file>',
      '<file path="empty.md">\n\n</file>', '<file path="last.md">\nlast file\n\n</file>',
    ], outcomes: [
      { kind: "file", reference: "first.md", status: "success" },
      { kind: "command", reference: "touch forbidden", status: "disabled" },
      { kind: "file", reference: "missing.md", status: "missing" },
      { kind: "file", reference: "large.md", status: "oversized" },
      { kind: "file", reference: "directory/", status: "success" },
      { kind: "file", reference: "empty.md", status: "success" },
      { kind: "file", reference: "last.md", status: "success" },
    ] }], files: { forbidden: null } }));

  test("canonical matching preserves offsets and resolves escaped extensionless references relative to baseDir", async () =>
    assertResolverEvents({ files: { "layer/src/README": "extensionless attachment", "layer/My Notes.md": "escaped attachment" },
      requests: [{ text: 'Use @src/README then @./My\\ Notes.md\n```md\n@missing.md !`echo fenced`\n```\n`@inline.md` and ``@src/NOT_READ``\nimport x from "@scope/package"\nuser@example.com @todo node_modules/@scope/package', baseDir: "layer", mode: "files" }],
    }, { replies: [{ statuses: ["success", "success"], context: [
      '<file path="src/README">\nextensionless attachment\n</file>', '<file path="./My Notes.md">\nescaped attachment\n</file>',
    ], references: [
      { kind: "file", reference: "src/README", index: 4, resolvedPath: "<cwd>/layer/src/README", status: "success", context: '<file path="src/README">\nextensionless attachment\n</file>' },
      { kind: "file", reference: "./My Notes.md", index: 21, resolvedPath: "<cwd>/layer/My Notes.md", status: "success", context: '<file path="./My Notes.md">\nescaped attachment\n</file>' },
    ] }] }));

  test("shared calls apply the configured timeout and omit unfinished output", { timeout: 5000 }, async () =>
    assertResolverEvents({ project: { limits: { commandTimeoutMs: 100 }, sources: { extension: { commands: true } } },
      requests: [{ text: '!`printf partial; sleep 1; printf late`' }],
    }, { replies: [{ context: [], statuses: ["error"], references: [
      { kind: "command", reference: "printf partial; sleep 1; printf late", index: 0, status: "error", reason: "command timed out or was killed" },
    ] }] }));

  test("raising the timeout lets commands run beyond the former fixed deadline", { timeout: 20000 }, async () =>
    assertResolverEvents({ project: { limits: { commandTimeoutMs: 15000 }, sources: { extension: { commands: true } } },
      requests: [{ text: '!`sleep 10.1; printf done`' }],
    }, { replies: [{ context: ['<bash command="sleep 10.1; printf done">\ndone\n</bash>'], statuses: ["success"], references: [
      { kind: "command", reference: "sleep 10.1; printf done", index: 0, status: "success", context: '<bash command="sleep 10.1; printf done">\ndone\n</bash>' },
    ] }] }));
});

describe("Directory listings", () => {
  test("sorted immediate entries are listed without importing child content or recursing", async () =>
    assertResolverEvents({ files: { "library/z.md": "PRIVATE", "library/a.md": '@missing.md !`touch forbidden`', "library/nested/hidden.md": "PRIVATE" },
      requests: [{ text: "@library/ @./library" }],
    }, { replies: [{ statuses: ["success", "success"], context: [
      '<file path="library/">\nDirectory listing (immediate entries):\na.md\nnested/\nz.md\n</file>',
      '<file path="./library">\nDirectory listing (immediate entries):\na.md\nnested/\nz.md\n</file>',
    ] }], files: { forbidden: null } }));

  test("the entry cap reports the exact omitted suffix", async () =>
    assertResolverEvents({ files: Object.fromEntries(Array.from({ length: 1002 }, (_, index) => [`library/file-${String(index).padStart(4, "0")}`, ""])),
      requests: [{ text: "@library/" }],
    }, { replies: [{ statuses: ["success"], context: [
      '<file path="library/">\nDirectory listing (immediate entries):\n' +
        Array.from({ length: 1000 }, (_, index) => `file-${String(index).padStart(4, "0")}`).join("\n") + '\n[truncated: 2 entries omitted]\n</file>',
    ] }] }));

  test("the listing byte cap counts multibyte names and retains a whole-entry prefix", async () =>
    assertResolverEvents({ files: Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`library/${String(index).padStart(4, "0")}-${"é".repeat(120)}`, ""])),
      requests: [{ text: "@library/" }],
    }, { replies: [{ statuses: ["success"], context: [
      '<file path="library/">\nDirectory listing (immediate entries):\n' +
        Array.from({ length: 406 }, (_, index) => `${String(index).padStart(4, "0")}-${"é".repeat(120)}`).join("\n") + '\n[truncated: 94 entries omitted]\n</file>',
    ] }] }));
});

describe("Caller policy", () => {
  test("all-mode shared commands remain disabled by default without preventing files", async () =>
    assertResolverEvents({ files: { "a.md": "A" }, requests: [{ text: '@a.md !`touch forbidden`', mode: "all" }] },
      { replies: [{ context: ['<file path="a.md">\nA\n</file>'], statuses: ["success", "disabled"],
        reasons: [undefined, "command resolution is disabled"] }], files: { forbidden: null } }));

  test("file-only mode overrides enabled commands while honoring disabled files", async () =>
    assertResolverEvents({ project: { defaults: { files: false, commands: true } }, files: { "source.md": "PRIVATE" },
      requests: [{ text: '@source.md !`touch forbidden`', mode: "files" }],
    }, { replies: [{ context: [], statuses: ["disabled", "disabled"], references: [
      { kind: "file", reference: "source.md", index: 0, status: "disabled", reason: "file resolution is disabled" },
      { kind: "command", reference: "touch forbidden", index: 11, status: "disabled", reason: "command execution is disabled in file-only mode" },
    ] }], files: { forbidden: null } }));
});

describe("Request budgets", () => {
  test("an empty file fits when only its wrapper fits the budget", async () =>
    assertResolverEvents({ files: { "a.md": "" }, project: { limits: { maxTotalBytes: 27 } }, requests: [{ text: "@a.md" }] },
      { replies: [{ context: ['<file path="a.md">\n\n</file>'], statuses: ["success"], references: [
        { kind: "file", reference: "a.md", index: 0, status: "success", resolvedPath: "<cwd>/a.md", context: '<file path="a.md">\n\n</file>' },
      ] }] }));

  test("a silent command does not start when only its wrapper fits the budget", async () =>
    assertResolverEvents({ project: { limits: { maxTotalBytes: 41 }, sources: { extension: { commands: true } } },
      requests: [{ text: '!`touch forbidden`' }],
    }, { replies: [{ context: [], statuses: ["oversized"], references: [
      { kind: "command", reference: "touch forbidden", index: 0, status: "oversized", reason: "total byte budget exceeded" },
    ] }], files: { forbidden: null } }));

  test("UTF-8 wrappers count toward total capacity and each shared request gets a fresh budget", async () =>
    assertResolverEvents({ project: { limits: { maxTotalBytes: 29 } }, files: { "a.md": "é", "b.md": "B" },
      requests: [{ text: "@a.md @b.md" }, { text: "@b.md" }],
    }, { replies: [
      { context: ['<file path="a.md">\né\n</file>'], statuses: ["success", "oversized"], reasons: [undefined, "total byte budget exceeded"] },
      { context: ['<file path="b.md">\nB\n</file>'], statuses: ["success"] },
    ] }));

  test("per-item failures consume no total capacity and mixed references retain admission order", async () =>
    assertResolverEvents({ project: { limits: { maxFileBytes: 2, maxCommandBytes: 2, maxTotalBytes: 66 }, sources: { extension: { commands: true } } },
      files: { "a.md": "é", "large.md": "éé" }, requests: [{ text: '@large.md !`printf é` @a.md !`printf éé`' }],
    }, { replies: [{ statuses: ["oversized", "success", "success", "oversized"],
      reasons: ["file exceeds 2 bytes", undefined, undefined, "command output exceeds 2 bytes"],
      context: ['<bash command="printf é">\né\n</bash>', '<file path="a.md">\né\n</file>'] }] }));

  test("exhausted shared capacity never starts later commands", async () =>
    assertResolverEvents({ project: { limits: { maxTotalBytes: 28 }, sources: { extension: { commands: true } } },
      files: { "a.md": "A" }, requests: [{ text: '@a.md !`touch forbidden`' }],
    }, { replies: [{ context: ['<file path="a.md">\nA\n</file>'], statuses: ["success", "oversized"],
      reasons: [undefined, "total byte budget exceeded"] }], files: { forbidden: null } }));
});
