import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SKILL_BLOCK_REGEX,
  buildCodeRanges,
  isInsideCode,
  unescapePath,
  isBareWord,
  extractFileRefs,
  extractCommandRefs,
} from "../extensions/matcher.ts";

// ---------- capture assertions ----------

/** What pi-resolve would resolve from a prompt: file paths and shell commands. */
function captures(text: string): { files: string[]; commands: string[] } {
  return {
    files: extractFileRefs(text),
    commands: extractCommandRefs(text).map((r) => r.command),
  };
}

function assertCapture(
  text: string,
  expected: { files?: string[]; commands?: string[] },
) {
  assert.deepEqual(captures(text), {
    files: expected.files ?? [],
    commands: expected.commands ?? [],
  });
}

const assertFileCapture = (text: string, file: string) =>
  assertCapture(text, { files: [file] });

const assertCommandCapture = (text: string, command: string) =>
  assertCapture(text, { commands: [command] });

const assertNoCapture = (text: string) => assertCapture(text, {});

// ---------- @file ----------

test("@file: bare reference", () =>
  assertFileCapture("hello @file.md world", "file.md"));

test("@file: home-dir reference", () =>
  assertFileCapture("open @~/notes/today.md please", "~/notes/today.md"));

test("@file: inside inline code is skipped", () =>
  assertNoCapture("see `@file.md` here"));

test("@file: inside fenced block is skipped", () =>
  assertNoCapture("before\n```\n@file.md\n```\nafter"));

test("@file: email-like address is not a file", () =>
  assertNoCapture("ping me at user@example.com"));

test("@file: npm scope after slash is not a file", () =>
  assertNoCapture("see node_modules/@scope/pkg/x"));

test("@file: quoted import is not a file", () => {
  assertNoCapture('import x from "@scope/pkg"');
  assertNoCapture("import x from '@scope/pkg'");
});

test("@file: backslash before @ does NOT suppress (documents non-escape)", () =>
  assertFileCapture("literal \\@file.md", "file.md"));

test("@file: bare word (no slash, no dot) is dropped", () =>
  assertNoCapture("an @todo item"));

test("@file: escaped space in path", () =>
  assertFileCapture("open @./My\\ Notes.md", "./My Notes.md"));

test("@file: escaped comma in path", () =>
  assertFileCapture("open @./a\\,b.md", "./a,b.md"));

test("@file: escaped parentheses in path", () =>
  assertFileCapture("open @./a\\(b\\).txt", "./a(b).txt"));

test("@file: unescaped comma terminates the path", () =>
  assertFileCapture("open @./a,b.md", "./a"));

test("@file: markdown link does not produce a capture from inside (...)", () =>
  assertFileCapture("see [doc](./@x.md) and @./y.md", "./y.md"));

test("@file: multiple references", () =>
  assertCapture("see @./a.md and @./b.md", {
    files: ["./a.md", "./b.md"],
  }));

// ---------- !`command` ----------

test("!`cmd`: bare reference", () =>
  assertCommandCapture("today is !`date`", "date"));

test("!`cmd`: backtick before ! suppresses", () =>
  assertNoCapture("literal `!`date``"));

test("!`cmd`: inside fenced block is skipped", () =>
  assertNoCapture("before\n```\n!`date`\n```\nafter"));

test("!`cmd`: backslash before ! does NOT suppress (documents non-escape)", () =>
  assertCommandCapture("literal \\!`date`", "date"));

test("!`cmd`: backslash before backtick breaks the pattern (accidental, not a real escape)", () =>
  assertNoCapture("literal !\\`date\\`"));

test("!`cmd`: empty command does not match", () =>
  assertNoCapture("x !`` y"));

test("!`cmd`: multiple in one line", () =>
  assertCapture("a !`echo 1` b !`echo 2` c", {
    commands: ["echo 1", "echo 2"],
  }));

// ---------- mixed ----------

test("mixed: file and command in same prompt", () =>
  assertCapture("see @./readme.md and run !`pwd`", {
    files: ["./readme.md"],
    commands: ["pwd"],
  }));

// ---------- <skill> envelope ----------

const SKILL_SAMPLE = [
  '<skill name="my-skill" location="/abs/path/SKILL.md">',
  "References are relative to /abs/path.",
  "",
  "Body line 1",
  "Body line 2",
  "</skill>",
].join("\n");

test("SKILL_BLOCK_REGEX: captures name, location, baseDir, body (no args)", () => {
  const m = SKILL_SAMPLE.match(SKILL_BLOCK_REGEX);
  assert.ok(m, "expected a match");
  assert.equal(m![1], "my-skill");
  assert.equal(m![2], "/abs/path/SKILL.md");
  assert.equal(m![3], "/abs/path");
  assert.equal(m![4], "Body line 1\nBody line 2");
  assert.equal(m![5], undefined);
});

test("SKILL_BLOCK_REGEX: captures trailing arguments after the envelope", () => {
  const text = SKILL_SAMPLE + "\n\narg1 arg2 arg3";
  const m = text.match(SKILL_BLOCK_REGEX);
  assert.ok(m);
  assert.equal(m![5], "arg1 arg2 arg3");
});

test("SKILL_BLOCK_REGEX: multi-line body preserved verbatim", () => {
  const body = "line A\n\nline C\n    indented";
  const text = [
    '<skill name="s" location="/p/SKILL.md">',
    "References are relative to /p.",
    "",
    body,
    "</skill>",
  ].join("\n");
  const m = text.match(SKILL_BLOCK_REGEX);
  assert.ok(m);
  assert.equal(m![4], body);
});

test("SKILL_BLOCK_REGEX: anchored — leading content disqualifies", () => {
  const text = "prefix\n" + SKILL_SAMPLE;
  assert.equal(text.match(SKILL_BLOCK_REGEX), null);
});

test("SKILL_BLOCK_REGEX: non-skill text does not match", () => {
  assert.equal("just a regular message".match(SKILL_BLOCK_REGEX), null);
});

// ---------- unit helpers ----------

test("unescapePath collapses backslash escapes", () => {
  assert.equal(unescapePath("./My\\ Notes.md"), "./My Notes.md");
  assert.equal(unescapePath("a\\,b"), "a,b");
  assert.equal(unescapePath("no-escapes"), "no-escapes");
});

test("isBareWord true only when no / and no .", () => {
  assert.equal(isBareWord("todo"), true);
  assert.equal(isBareWord("scope/pkg"), false);
  assert.equal(isBareWord("file.md"), false);
  assert.equal(isBareWord("~/file"), false);
});

test("buildCodeRanges marks fence and inline-span offsets as inside code", () => {
  const text = "a `inline` b\n```\nfenced\n```\nc";
  const ranges = buildCodeRanges(text);
  const insideInline = text.indexOf("inline");
  const insideFence = text.indexOf("fenced");
  assert.equal(isInsideCode(insideInline, ranges), true);
  assert.equal(isInsideCode(insideFence, ranges), true);
  assert.equal(isInsideCode(text.indexOf("a "), ranges), false);
  assert.equal(isInsideCode(text.lastIndexOf("c"), ranges), false);
});
