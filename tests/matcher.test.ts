import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  SKILL_BLOCK_REGEX,
  buildCodeRanges,
  isInsideCode,
  unescapePath,
  isBareWord,
  extractFileRefs,
  extractFileReferenceMatches,
  extractCommandRefs,
} from "../src/matcher.ts";


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


describe("@file", () => {
  test("@file: bare reference", () =>
    assertFileCapture("hello @file.md world", "file.md"));

  test("@file: home-dir reference", () =>
    assertFileCapture("open @~/notes/today.md please", "~/notes/today.md"));

  test("@file: inside inline code is skipped", () =>
    assertNoCapture("see `@file.md` here"));

  test("@file: inside fenced block is skipped", () =>
    assertNoCapture("before\n```\n@file.md\n```\nafter"));

  test("@file: inside tilde fence is skipped", () =>
    assertNoCapture("~~~\n@hidden.md\n~~~"));

  test("@file: email-like address is not a file", () =>
    assertNoCapture("ping me at user@example.com"));

  test("@file: npm scope after slash is not a file", () =>
    assertNoCapture("see node_modules/@scope/pkg/x"));

  test("@file: quoted import is not a file", () => {
    assertNoCapture('import x from "@scope/pkg"');
    assertNoCapture("import x from '@scope/pkg'");
  });

  test("@file: backslash before @ suppresses resolution", () =>
    assertNoCapture("literal \\@file.md"));

  test("@file: odd backslash runs suppress home and relative paths", () =>
    assertCapture(String.raw`\@~/notes.md \\\@./hidden.md @visible.md`, {
      files: ["visible.md"],
    }));

  test("@file: even backslash runs allow references and path escapes", () =>
    assertCapture(String.raw`\\@./My\ Notes.md \\\\@~/notes.md`, {
      files: ["./My Notes.md", "~/notes.md"],
    }));

  test("@file: even backslash runs do not enable bare names", () =>
    assertNoCapture(String.raw`\\@README \\\\@todo`));

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
});

describe("!`command`", () => {
  test("!`cmd`: bare reference", () =>
    assertCommandCapture("today is !`date`", "date"));

  test("!`cmd`: backtick before ! suppresses", () =>
    assertNoCapture("literal `!`date``"));

  test("!`cmd`: inside fenced block is skipped", () =>
    assertNoCapture("before\n```\n!`date`\n```\nafter"));

  test("!`cmd`: inside tilde shell fence is skipped", () =>
    assertNoCapture("~~~sh\n!`date`\n~~~"));

  test("!`cmd`: backslash before ! suppresses resolution", () =>
    assertNoCapture("literal \\!`date`"));

  test("!`cmd`: odd backslash runs suppress only the escaped reference", () =>
    assertCommandCapture("\\\\\\!`hidden` !`visible`", "visible"));

  test("!`cmd`: even backslash runs allow references", () =>
    assertCapture("\\\\!`first` \\\\\\\\!`second`", {
      commands: ["first", "second"],
    }));

  test("!`cmd`: escaped backticks and shell escapes are preserved verbatim", () =>
    assertCommandCapture(
      "!`echo \\`date\\` \\$HOME a\\ b`",
      "echo \\`date\\` \\$HOME a\\ b",
    ));

  test("!`cmd`: three backslashes escape a backtick without truncation", () =>
    assertCommandCapture("!`echo \\\\\\`tail`", "echo \\\\\\`tail"));

  test("!`cmd`: two backslashes allow the backtick to close", () =>
    assertCapture("!`echo \\\\` @after.md !`next`", {
      files: ["after.md"], commands: ["echo \\\\", "next"],
    }));

  test("!`cmd`: four backslashes also allow the backtick to close", () =>
    assertCommandCapture("!`echo \\\\\\\\`", "echo \\\\\\\\"));

  test("!`cmd`: escaped final backtick cannot produce a partial command", () =>
    assertNoCapture("!`echo \\`"));

  test("!`cmd`: unmatched escaped backtick with trailing text stays unresolved", () =>
    assertCapture("@before.md !`echo \\` tail @after.md", {
      files: ["before.md", "after.md"],
    }));

  test("!`cmd`: missing closing backtick stays unresolved", () =>
    assertCapture("!`echo unfinished @after.md", { files: ["after.md"] }));

  test("!`cmd`: a lone escaped backtick is valid command content", () =>
    assertCommandCapture("!`\\``", "\\`"));

  test("!`cmd`: escaped backticks in multiline commands stay verbatim", () =>
    assertCommandCapture("!`echo \\`first\r\nsecond\\`\necho done`", "echo \\`first\r\nsecond\\`\necho done"));

  test("!`cmd`: backslash between ! and the opening backtick is not command syntax", () =>
    assertNoCapture("literal !\\`date\\`"));

  test("!`cmd`: cannot close inside a fenced block", () =>
    assertNoCapture("!`echo\n~~~sh\nhidden`\n~~~"));

  test("!`cmd`: multiline command outside code is preserved", () =>
    assertCommandCapture("!`echo first\necho second`", "echo first\necho second"));

  test("!`cmd`: empty command does not match", () =>
    assertNoCapture("x !`` y"));

  test("!`cmd`: multiple in one line", () =>
    assertCapture("a !`echo 1` b !`echo 2` c", {
      commands: ["echo 1", "echo 2"],
    }));
});

describe("mixed", () => {
  test("mixed: file and command in same prompt", () =>
    assertCapture("see @./readme.md and run !`pwd`", {
      files: ["./readme.md"],
      commands: ["pwd"],
    }));
});

describe("fenced code", () => {
  test("fences: escapes do not enable references inside backtick fences", () =>
    assertCapture("```sh\n\\\\@hidden.md \\\\!`echo \\`hidden\\``\n```\n@visible.md !`visible`", {
      files: ["visible.md"], commands: ["visible"],
    }));

  test("fences: escaped command delimiters cannot cross tilde fences", () =>
    assertCapture("!`echo \\`\n~~~\nhidden`\n~~~\n@visible.md !`visible`", {
      files: ["visible.md"], commands: ["visible"],
    }));

  test("fences: three-space indentation is allowed", () =>
    assertCapture("   ~~~sh\n@hidden.md !`hidden`\n   ~~~\n@visible.md !`visible`", {
      files: ["visible.md"], commands: ["visible"],
    }));

  test("fences: shorter backtick run does not close a longer fence", () =>
    assertCapture("````\n```\n@hidden.md !`hidden`\n````\n@visible.md !`visible`", {
      files: ["visible.md"], commands: ["visible"],
    }));

  test("fences: longer closing run is allowed", () =>
    assertCapture("~~~\n@hidden.md !`hidden`\n~~~~~\n@visible.md !`visible`", {
      files: ["visible.md"], commands: ["visible"],
    }));

  test("fences: different fence character does not close a fence", () =>
    assertCapture("~~~\n```\n@hidden.md !`hidden`\n~~~\n@visible.md !`visible`", {
      files: ["visible.md"], commands: ["visible"],
    }));

  test("fences: closing run followed by text is not a closer", () =>
    assertCapture("```\n``` not-a-close\n@hidden.md !`hidden`\n```\n@visible.md !`visible`", {
      files: ["visible.md"], commands: ["visible"],
    }));

  test("fences: closing run allows trailing spaces and tabs", () =>
    assertCapture("~~~\n@hidden.md !`hidden`\n~~~ \t\n@visible.md !`visible`", {
      files: ["visible.md"], commands: ["visible"],
    }));

  test("fences: CRLF preserves fence boundaries", () =>
    assertCapture("~~~sh\r\n@hidden.md !`hidden`\r\n~~~\r\n@visible.md !`visible`", {
      files: ["visible.md"], commands: ["visible"],
    }));

  test("fences: references in the fence info string are suppressed", () =>
    assertCapture("~~~ @hidden.md !`hidden`\n~~~\n@visible.md !`visible`", {
      files: ["visible.md"], commands: ["visible"],
    }));

  test("fences: unclosed tilde fence suppresses through EOF", () =>
    assertCapture("@visible.md !`visible`\n~~~sh\n@hidden.md !`hidden`", {
      files: ["visible.md"], commands: ["visible"],
    }));

  test("fences: unclosed backtick fence suppresses through EOF", () =>
    assertCapture("@visible.md !`visible`\n```sh\n@hidden.md !`hidden`", {
      files: ["visible.md"], commands: ["visible"],
    }));

  test("fences: closing fence at EOF is sufficient", () =>
    assertCapture("@visible.md !`visible`\n~~~\n@hidden.md !`hidden`\n~~~", {
      files: ["visible.md"], commands: ["visible"],
    }));

  test("fences: two tildes do not open a fence", () =>
    assertCommandCapture("~~\n!`visible`\n~~", "visible"));

  test("fences: backtick in backtick-fence info string invalidates opener", () =>
    assertCommandCapture("```sh`x`\n!`visible`", "visible"));
});

describe("inline code", () => {
  test("spans: escaped command backticks do not hide nearby references", () =>
    assertCapture("!`echo \\`date\\`` @visible.md !`next` `@hidden.md`", {
      files: ["visible.md"], commands: ["echo \\`date\\`", "next"],
    }));

  test("spans: command delimiter parity does not change code-span pairing", () =>
    assertCapture("`` \\\\@hidden.md \\\\!`echo \\`hidden\\`` `` @visible.md !`next`", {
      files: ["visible.md"], commands: ["next"],
    }));

  test("spans: escaped command markers leave their contents as inline code", () =>
    assertCapture("\\!`@hidden.md` @visible.md !`next`", {
      files: ["visible.md"], commands: ["next"],
    }));

  test("spans: escaped markers use code-span closers without consuming the next command", () =>
    assertCapture("\\!`literal \\` @visible.md !`next`", {
      files: ["visible.md"], commands: ["next"],
    }));

  test("spans: suppressed command candidates cannot consume a following prose command", () =>
    assertCapture("`` !`literal \\` `` @visible.md !`next`", {
      files: ["visible.md"], commands: ["next"],
    }));

  test("spans: double-backtick span contains shell delimiters", () =>
    assertCapture("`` @hidden.md !`hidden` `` @visible.md !`visible`", {
      files: ["visible.md"], commands: ["visible"],
    }));

  test("spans: longer span contains shorter backtick runs", () =>
    assertCapture("```` example `` @hidden.md !`hidden` ```` @visible.md !`visible`", {
      files: ["visible.md"], commands: ["visible"],
    }));

  test("spans: code span may cross a newline", () =>
    assertCapture("`` example\n@hidden.md !`hidden`\n`` @visible.md !`visible`", {
      files: ["visible.md"], commands: ["visible"],
    }));

  test("spans: unmatched opening run stays literal", () =>
    assertCapture("unmatched ``` @visible.md !`visible`", {
      files: ["visible.md"], commands: ["visible"],
    }));

  test("spans: inline span cannot cross a fenced block", () =>
    assertCapture("before ``\n~~~\n@hidden.md !`hidden`\n~~~\n@visible.md !`visible`\nend ``", {
      files: ["visible.md"], commands: ["visible"],
    }));

  test("spans: references immediately outside a span remain visible", () =>
    assertCapture("@before.md `@hidden.md` !`after`", {
      files: ["before.md"],
      commands: ["after"],
    }));

  test("spans: many unmatched runs leave subsequent references visible", () =>
    assertFileCapture(
      Array.from({ length: 256 }, (_, index) => "`".repeat(index + 2)).join(" x ") + " @visible.md",
      "visible.md",
    ));
});

describe("reference offsets", () => {
  test("offsets: escape prefixes stay outside matches and command escapes stay inside", () => {
    const text = "😀 \\@no.md \\\\@a\\ b.md \\!`no` \\\\!`echo \\`x\\`` @z.md";
    assert.deepEqual(extractFileReferenceMatches(text), [
      { index: 13, fullMatch: "@a\\ b.md", path: "a b.md" },
      { index: 45, fullMatch: "@z.md", path: "z.md" },
    ]);
    assert.deepEqual(extractCommandRefs(text), [
      { index: 31, fullMatch: "!`echo \\`x\\``", command: "echo \\`x\\`" },
    ]);
  });

  test("offsets: UTF-16 indices and escaped source text are preserved", () => {
    const text = "😀 @a\\ b.md !`echo ok` @a\\ b.md";
    assert.deepEqual(extractFileReferenceMatches(text), [
      { index: 3, fullMatch: "@a\\ b.md", path: "a b.md" },
      { index: 23, fullMatch: "@a\\ b.md", path: "a b.md" },
    ]);
    assert.deepEqual(extractCommandRefs(text), [
      { index: 12, fullMatch: "!`echo ok`", command: "echo ok" },
    ]);
  });
});

describe("<skill> envelope", () => {
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
});

describe("unit helpers", () => {
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
});
