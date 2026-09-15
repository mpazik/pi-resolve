import { describe, test } from "node:test";
import {
  assertSessionTurns, assertSourceResolution, assertPersistedTurns,
  assertNewSession, assertResumedSession, assertReloadedSession,
  assertExtensionConsumer, assertToolConsumer, assertRawTool, assertInjectedPrompt,
} from "./fixtures/session-assertions.mock.ts";

const files = { "note.md": "PROJECT_NOTE", "secret.md": "SECRET_MUST_NOT_BE_ATTACHED" };

describe("Direct input and persistence", () => {

  test("typed text and attachments persist across turns without replaying commands", async (t) =>
    assertPersistedTurns(
      { files, prompts: ["@note.md !`printf x >> count; printf FIRST`", "second !`printf x >> count; printf SECOND`"] },
      {
        turns: [
          { attachments: ['<bash command="printf x >> count; printf FIRST">\nFIRST\n</bash>', '<file path="note.md">\nPROJECT_NOTE\n</file>'],
            textIncludes: ["@note.md !`printf x >> count; printf FIRST`"] },
          { attachments: ['<bash command="printf x >> count; printf FIRST">\nFIRST\n</bash>', '<file path="note.md">\nPROJECT_NOTE\n</file>',
            '<bash command="printf x >> count; printf SECOND">\nSECOND\n</bash>'],
            textIncludes: ["@note.md !`printf x >> count; printf FIRST`"] },
        ],
        files: { count: "xx" }, customMessages: 2, assistantMessages: 2,
        originalUserText: "@note.md !`printf x >> count; printf FIRST`",
      },
      { t },
    ));
});

describe("Templates and skills", () => {

  test("real skill expansion uses skill files, project commands, trailing args, and substitutions", async (t) =>
    assertSessionTurns(
      {
        projectSettings: JSON.stringify({ sources: { skill: { commands: true } } }),
        files: {
          ...files,
          ".pi/skills/demo/SKILL.md": '---\nname: demo\ndescription: Resolver fixture\n---\n@note.md @arg-$0.md\n!`printf x >> skill-count; unset UNSET_FIXTURE; printf "%s" "$ARGUMENTS|$ARGUMENTS[0]|$0|$1|$9|${UNSET_FIXTURE:-fallback}"; pwd`',
          ".pi/skills/demo/note.md": "SKILL_NOTE",
          ".pi/skills/demo/arg-alpha.md": "SUBSTITUTED_FILE",
        },
        prompts: ["/skill:demo alpha @note.md"],
      },
      {
        turns: [
          {
            attachments: [
              '<bash command="printf x >> skill-count; unset UNSET_FIXTURE; printf "%s" "alpha @note.md|alpha|alpha|@note.md||${UNSET_FIXTURE:-fallback}"; pwd">\nalpha @note.md|alpha|alpha|@note.md||fallback<cwd>\n</bash>',
              '<file path="note.md">\nPROJECT_NOTE\n</file>',
              '<file path="note.md">\nSKILL_NOTE\n</file>',
              '<file path="arg-alpha.md">\nSUBSTITUTED_FILE\n</file>',
            ],
          },
        ],
        files: { "skill-count": "x" },
      },
      { t },
    ));

  test("real prompt templates resolve project files and substituted commands under template policy", async (t) =>
    assertSessionTurns(
      {
        projectSettings: JSON.stringify({ sources: { template: { commands: true } } }),
        files: {
          ...files,
          ".pi/prompts/demo.md": '---\ndescription: Resolver fixture\n---\n@note.md !`printf x >> template-count; printf "$1"`',
        },
        prompts: ["/demo TEMPLATE_OUTPUT"],
      },
      {
        turns: [
          {
            attachments: [
              '<bash command="printf x >> template-count; printf "TEMPLATE_OUTPUT"">\nTEMPLATE_OUTPUT\n</bash>',
              '<file path="note.md">\nPROJECT_NOTE\n</file>',
            ],
          },
        ],
        files: { "template-count": "x" },
      },
      { t },
    ));

  test("identical template references conservatively retain disabled direct-input policy", async (t) =>
    assertSessionTurns(
      {
        projectSettings: JSON.stringify({ sources: { userInput: { files: false } } }),
        files: { "sample.txt": "TEMPLATE_FILE", ".pi/prompts/demo.md": "$ARGUMENTS @sample.txt" },
        prompts: ["/demo @sample.txt @sample.txt"],
      },
      { turns: [{ attachments: [], textExcludes: /TEMPLATE_FILE/ }] },
      { t },
    ));

  test("skill trailing and substituted arguments retain disabled direct file policy without blocking skill files", async (t) =>
    assertSessionTurns(
      {
        projectSettings: JSON.stringify({ sources: { userInput: { files: false } } }),
        files: {
          "sample.txt": "FORBIDDEN_PROJECT_FILE",
          ".pi/skills/demo/sample.txt": "FORBIDDEN_SKILL_ARG_FILE",
          ".pi/skills/demo/own.txt": "SKILL_FILE",
          ".pi/skills/demo/arg-next.txt": "POSITION_PRESERVED",
          ".pi/skills/demo/SKILL.md": "---\nname: demo\ndescription: fixture\n---\n$ARGUMENTS $0 @own.txt @arg-$1.txt",
        },
        prompts: ["/skill:demo @sample.txt next"],
      },
      {
        turns: [
          {
            attachments: [
              '<file path="own.txt">\nSKILL_FILE\n</file>',
              '<file path="arg-next.txt">\nPOSITION_PRESERVED\n</file>',
            ],
            textExcludes: /FORBIDDEN_/,
          },
        ],
      },
      { t },
    ));

  test("duplicated template arguments cannot re-enable disabled direct files or commands", async (t) =>
    assertSessionTurns(
      {
        projectSettings: JSON.stringify({ sources: { userInput: { files: false, commands: false }, template: { commands: true } } }),
        files: {
          "sample.txt": "FORBIDDEN_FILE",
          "fresh.txt": "TEMPLATE_FILE",
          ".pi/prompts/demo.md": "$ARGUMENTS $ARGUMENTS @fresh.txt !`printf x >> template-count`",
        },
        prompts: ["/demo @sample.txt !`touch forbidden`"],
      },
      {
        turns: [
          {
            attachments: [
              '<bash command="printf x >> template-count">\n\n</bash>',
              '<file path="fresh.txt">\nTEMPLATE_FILE\n</file>',
            ],
            textExcludes: /FORBIDDEN_FILE/,
          },
        ],
        files: { "template-count": "x", forbidden: null },
      },
      { t },
    ));

  test("skill command opt-in cannot re-enable direct commands through repeated arguments", async (t) =>
    assertSessionTurns(
      {
        projectSettings: JSON.stringify({ sources: { userInput: { commands: false }, skill: { commands: true } } }),
        files: {
          ".pi/skills/demo/SKILL.md": "---\nname: demo\ndescription: fixture\n---\n$ARGUMENTS $ARGUMENTS !`printf x >> skill-count`",
        },
        prompts: ["/skill:demo !`touch forbidden`"],
      },
      {
        turns: [{ attachments: ['<bash command="printf x >> skill-count">\n\n</bash>'] }],
        files: { "skill-count": "x", forbidden: null },
      },
      { t },
    ));

});

describe("Escaped references across SDK expansion", () => {
  test("escaped references stay literal while shell backticks reach sh unchanged", async (t) =>
    assertSessionTurns({ files: { "private.md": "MUST_NOT_BE_IMPORTED", "note.md": "NOTE" },
      prompts: ['\\@private.md \\!`touch forbidden` @note.md !`printf "%s" "a\\`b"`'] },
    { turns: [{ attachments: ['<bash command="printf "%s" "a\\`b"">\na`b\n</bash>', '<file path="note.md">\nNOTE\n</file>'],
      textIncludes: ['\\@private.md \\!`touch forbidden` @note.md !`printf "%s" "a\\`b"`'], textExcludes: /MUST_NOT_BE_IMPORTED/ }],
      files: { forbidden: null } }, { t }));

  test("escaped system references stay literal on subsequent turns", async (t) =>
    assertSessionTurns({ files: { "AGENTS.md": '\\@private.md \\!`touch forbidden`', "private.md": "MUST_NOT_BE_IMPORTED" },
      prompts: ["first", "second"] },
    { turns: [
      { attachments: [], systemIncludes: ['\\@private.md \\!`touch forbidden`'], textExcludes: /MUST_NOT_BE_IMPORTED/ },
      { attachments: [], systemIncludes: ['\\@private.md \\!`touch forbidden`'], textIncludes: ["first", "OK", "second"], textExcludes: /MUST_NOT_BE_IMPORTED/ },
    ], customMessages: 0, files: { forbidden: null } }, { t }));

  test("template expansion preserves escaped argument references", async (t) =>
    assertSessionTurns({ files: { "private.md": "MUST_NOT_BE_IMPORTED", ".pi/prompts/demo.md": "$ARGUMENTS !`printf TEMPLATE`" },
      projectSettings: JSON.stringify({ sources: { template: { commands: true } } }), prompts: ['/demo \\@private.md \\!`touch forbidden`'] },
    { turns: [{ attachments: ['<bash command="printf TEMPLATE">\nTEMPLATE\n</bash>'],
      textIncludes: ['\\@private.md \\!`touch forbidden` !`printf TEMPLATE`'], textExcludes: /MUST_NOT_BE_IMPORTED/ }], files: { forbidden: null } }, { t }));

  test("skill substitution preserves escaped argument references", async (t) =>
    assertSessionTurns({ files: { "private.md": "MUST_NOT_BE_IMPORTED", ".pi/skills/demo/private.md": "MUST_NOT_BE_IMPORTED",
      ".pi/skills/demo/SKILL.md": '---\nname: demo\ndescription: fixture\n---\n$ARGUMENTS !`printf SKILL`' },
      projectSettings: JSON.stringify({ sources: { skill: { commands: true } } }), prompts: ['/skill:demo \\@private.md \\!`touch forbidden`'] },
    { turns: [{ attachments: ['<bash command="printf SKILL">\nSKILL\n</bash>'], textExcludes: /MUST_NOT_BE_IMPORTED/ }], files: { forbidden: null } }, { t }));
});

describe("System context", () => {

  test("loaded AGENTS context resolves once and command output stays inert", async (t) =>
    assertSessionTurns(
      {
        files: {
          ...files,
          "AGENTS.md": "@note.md !`printf x >> system-count; cat output.txt`",
          "output.txt": "@secret.md !`touch forbidden` SYSTEM_OUTPUT",
        },
        prompts: ["first", "second"],
      },
      {
        turns: [
          {
            attachments: ['<file path="note.md">\nPROJECT_NOTE\n</file>'],
            systemIncludes: ["SYSTEM_OUTPUT"],
            textExcludes: /SECRET_MUST_NOT_BE_ATTACHED/,
          },
          {
            attachments: ['<file path="note.md">\nPROJECT_NOTE\n</file>'],
            systemIncludes: ["SYSTEM_OUTPUT"],
          },
        ],
        files: { "system-count": "x", forbidden: null },
      },
      { t },
    ));
});

describe("Turn budgets", () => {

  test("turn total admits direct, system and template imports in order including wrappers", async (t) =>
    assertSessionTurns(
      {
        projectSettings: JSON.stringify({ limits: { maxTotalBytes: 59 } }),
        files: {
          "a.md": "A",
          "b.md": "B",
          "c.md": "C",
          "AGENTS.md": "!`printf SYS`",
          ".pi/prompts/demo.md": "@b.md @c.md",
        },
        prompts: ["/demo @a.md"],
      },
      {
        turns: [
          {
            attachments: [
              '<file path="a.md">\nA\n</file>',
              '<file path="b.md">\nB\n</file>',
              '<file path="c.md" status="oversized" reason="total byte budget exceeded" />',
            ],
            systemIncludes: ["SYS"],
          },
        ],
      },
      { t },
    ));

  test("cached system output counts each turn without reexecution or redundant cache charges", async (t) =>
    assertSessionTurns(
      {
        projectSettings: JSON.stringify({ limits: { maxTotalBytes: 31 } }),
        files: { "a.md": "A", "big.md": "AB", "AGENTS.md": "!`printf x >> count; printf SYS`" },
        prompts: ["@a.md", "@big.md", "plain prompt"],
      },
      {
        turns: [
          {
            attachments: ['<file path="a.md">\nA\n</file>'],
            systemIncludes: ["SYS"],
            systemExcludes: ["!`printf x >> count; printf SYS`"],
          },
          {
            attachments: [
              '<file path="a.md">\nA\n</file>',
              '<bash command="printf x &gt;&gt; count; printf SYS" status="oversized" reason="total byte budget exceeded" />',
              '<file path="big.md">\nAB\n</file>',
            ],
            systemIncludes: ["!`printf x >> count; printf SYS`"],
          },
          {
            attachments: [
              '<file path="a.md">\nA\n</file>',
              '<bash command="printf x &gt;&gt; count; printf SYS" status="oversized" reason="total byte budget exceeded" />',
              '<file path="big.md">\nAB\n</file>',
            ],
            systemExcludes: ["!`printf x >> count; printf SYS`"],
          },
        ],
        files: { count: "x" },
      },
      { t },
    ));

  test("skill imports share the direct and system budget and omitted commands never start", async (t) =>
    assertSessionTurns(
      {
        projectSettings: JSON.stringify({ limits: { maxTotalBytes: 59 }, sources: { skill: { commands: true } } }),
        files: {
          "a.md": "A",
          "AGENTS.md": "!`printf SYS`",
          ".pi/skills/demo/SKILL.md": "---\nname: demo\ndescription: fixture\n---\n@b.md !`touch forbidden`",
          ".pi/skills/demo/b.md": "B",
        },
        prompts: ["/skill:demo @a.md"],
      },
      {
        turns: [
          {
            attachments: [
              '<bash command="touch forbidden" status="oversized" reason="total byte budget exceeded" />',
              '<file path="a.md">\nA\n</file>',
              '<file path="b.md">\nB\n</file>',
            ],
          },
        ],
        files: { forbidden: null },
      },
      { t },
    ));

});

describe("Source policy", () => {

  test("templates and skills default to files only while direct and AGENTS commands remain enabled", async (t) =>
    assertSessionTurns(
      {
        files: {
          "a.md": "A",
          "AGENTS.md": "!`printf x >> system-count; printf SYS`",
          ".pi/prompts/demo.md": "@a.md !`touch template-forbidden`",
          ".pi/skills/demo/SKILL.md": "---\nname: demo\ndescription: fixture\n---\n@note.md !`touch skill-forbidden`",
          ".pi/skills/demo/note.md": "SKILL_FILE",
        },
        prompts: ["!`printf x >> direct-count; printf DIRECT`", "/demo", "/skill:demo"],
      },
      {
        turns: [
          {
            attachments: ['<bash command="printf x >> direct-count; printf DIRECT">\nDIRECT\n</bash>'],
            summary: { labels: ["printf x >> direct-count; printf DIRECT"], display: true },
          },
          {
            attachments: [
              '<bash command="printf x >> direct-count; printf DIRECT">\nDIRECT\n</bash>',
              '<file path="a.md">\nA\n</file>',
            ],
            summary: { labels: ["a.md"], display: true },
          },
          {
            attachments: [
              '<bash command="printf x >> direct-count; printf DIRECT">\nDIRECT\n</bash>',
              '<file path="a.md">\nA\n</file>',
              '<file path="note.md">\nSKILL_FILE\n</file>',
            ],
            summary: { labels: [], display: false },
          },
        ],
        files: { "system-count": "x", "direct-count": "x", "template-forbidden": null, "skill-forbidden": null },
      },
      { t },
    ));

  test("disabled files and commands add no context and have no side effects across source paths", async (t) =>
    assertSessionTurns(
      {
        globalSettings: JSON.stringify({ defaults: { files: false, commands: false } }),
        projectSettings: JSON.stringify({ defaults: { display: "never" } }),
        files: {
          "ok.md": "MUST_NOT_ATTACH",
          "AGENTS.md": "@ok.md !`touch forbidden`",
          ".pi/skills/demo/SKILL.md": "---\nname: demo\ndescription: fixture\n---\n@ok.md !`touch forbidden`",
          ".pi/prompts/demo.md": "@ok.md !`touch forbidden`",
        },
        prompts: ["@ok.md !`touch forbidden`", "/skill:demo", "/demo"],
      },
      {
        turns: [
          { attachments: [], textExcludes: /MUST_NOT_ATTACH|<file path=|<bash command=/ },
          { attachments: [], textExcludes: /MUST_NOT_ATTACH|<file path=|<bash command=/ },
          { attachments: [], textExcludes: /MUST_NOT_ATTACH|<file path=|<bash command=/ },
        ],
        customMessages: 0,
        files: { forbidden: null },
      },
      { t },
    ));

});

describe("SDK source-policy routing", () => {
  test("disabling direct files preserves commands", async (t) =>
    assertSourceResolution({ source: "userInput", body: '@note.md !`printf x >> executed; printf COMMAND`', files: { "note.md": "FILE" },
      projectSettings: JSON.stringify({ sources: { userInput: { files: false, commands: true } } }) },
    { turns: [{ attachments: ['<bash command="printf x >> executed; printf COMMAND">\nCOMMAND\n</bash>'], textExcludes: /FILE/ }], files: { executed: "x" } }, { t }));

  test("disabling AGENTS commands preserves system files", async (t) =>
    assertSourceResolution({ source: "systemPrompt", body: '@note.md !`touch forbidden`', files: { "note.md": "FILE" },
      projectSettings: JSON.stringify({ sources: { systemPrompt: { files: true, commands: false } } }) },
    { turns: [{ attachments: ['<file path="note.md">\nFILE\n</file>'] }], files: { forbidden: null } }, { t }));

  test("disabling skill files preserves opted-in commands", async (t) =>
    assertSourceResolution({ source: "skill", body: '@note.md !`printf x >> executed; printf COMMAND`', files: { "note.md": "FILE" },
      projectSettings: JSON.stringify({ sources: { skill: { files: false, commands: true } } }) },
    { turns: [{ attachments: ['<bash command="printf x >> executed; printf COMMAND">\nCOMMAND\n</bash>'], textExcludes: /FILE/ }], files: { executed: "x" } }, { t }));

  test("disabling template files preserves opted-in commands", async (t) =>
    assertSourceResolution({ source: "template", body: '@note.md !`printf x >> executed; printf COMMAND`', files: { "note.md": "FILE" },
      projectSettings: JSON.stringify({ sources: { template: { files: false, commands: true } } }) },
    { turns: [{ attachments: ['<bash command="printf x >> executed; printf COMMAND">\nCOMMAND\n</bash>'], textExcludes: /FILE/ }], files: { executed: "x" } }, { t }));

});

describe("Failure context", () => {
  test("configured deadlines deliver direct and system failures without partial output or late side effects", { timeout: 5000 }, async (t) =>
    assertSessionTurns({ globalSettings: JSON.stringify({ limits: { commandTimeoutMs: 20000 } }),
      projectSettings: JSON.stringify({ limits: { commandTimeoutMs: 100 } }),
      files: { "AGENTS.md": '!`sleep 1; printf SYSTEM_LATE`' },
      prompts: ['!`printf x >> started; printf partial; sleep 1; touch forbidden`'] },
    { turns: [{ attachments: [
      '<bash command="printf x &gt;&gt; started; printf partial; sleep 1; touch forbidden" status="error" reason="command failed" />',
      '<bash command="sleep 1; printf SYSTEM_LATE" status="error" reason="command failed" />',
    ], systemIncludes: ['!`sleep 1; printf SYSTEM_LATE`'],
      summary: { labels: ['printf x >> started; printf partial; sleep 1; touch forbidden'], display: true, results: ["error"] },
    }], files: { started: "x", forbidden: null } }, { t }));

});

describe("Failure propagation across sources", () => {

  test("hidden summaries still deliver successful and failed imports to the provider", async (t) =>
    assertSourceResolution(
      {
        source: "userInput",
        body: "@ok.md @missing.md",
        projectSettings: JSON.stringify({ defaults: { display: "never" } }),
        files: { "ok.md": "MODEL_CONTENT" },
      },
      {
        turns: [
          {
            attachments: [
              '<file path="ok.md">\nMODEL_CONTENT\n</file>',
              '<file path="missing.md" status="missing" reason="file not found" />',
            ],
            summary: { labels: [], display: false },
          },
        ],
      },
      { t },
    ));

  test("AGENTS failures are attached while successful commands substitute into the system prompt", async (t) =>
    assertSourceResolution({ source: "systemPrompt", body: '@missing.md !`sh fail.sh` !`printf SUCCESS`',
      projectSettings: JSON.stringify({ defaults: { display: "never" } }),
      files: { "fail.sh": "printf PRIVATE_STDOUT; printf PRIVATE_STDERR >&2; exit 7" } },
    { turns: [{ attachments: ['<bash command="sh fail.sh" status="error" reason="command failed" />',
      '<file path="missing.md" status="missing" reason="file not found" />'],
      textExcludes: /PRIVATE_/, summary: { labels: [], display: false }, systemIncludes: ['!`sh fail.sh`', "SUCCESS"] }] }, { t }));

  test("skills deliver both safe failures and successful commands even with display never", async (t) =>
    assertSourceResolution({ source: "skill", body: '@missing.md !`sh fail.sh` !`printf SUCCESS`',
      projectSettings: JSON.stringify({ defaults: { display: "never" }, sources: { skill: { commands: true } } }),
      files: { "fail.sh": "printf PRIVATE_STDOUT; printf PRIVATE_STDERR >&2; exit 7" } },
    { turns: [{ attachments: ['<bash command="sh fail.sh" status="error" reason="command failed" />',
      '<bash command="printf SUCCESS">\nSUCCESS\n</bash>', '<file path="missing.md" status="missing" reason="file not found" />'],
      textExcludes: /PRIVATE_/, summary: { labels: [], display: false } }] }, { t }));

  test("templates deliver both safe failures and successful commands even with display never", async (t) =>
    assertSourceResolution({ source: "template", body: '@missing.md !`sh fail.sh` !`printf SUCCESS`',
      projectSettings: JSON.stringify({ defaults: { display: "never" }, sources: { template: { commands: true } } }),
      files: { "fail.sh": "printf PRIVATE_STDOUT; printf PRIVATE_STDERR >&2; exit 7" } },
    { turns: [{ attachments: ['<bash command="sh fail.sh" status="error" reason="command failed" />',
      '<bash command="printf SUCCESS">\nSUCCESS\n</bash>', '<file path="missing.md" status="missing" reason="file not found" />'],
      textExcludes: /PRIVATE_/, summary: { labels: [], display: false } }] }, { t }));
});

describe("Session lifecycle", () => {
  // Resume and reload intentionally cover files, not unspecified command-cache lifetimes.

  test("new SDK session clears history and runs system commands once in each fresh session", async (t) =>
    assertNewSession(
      {
        files: {
          "AGENTS.md": "@system.txt\n!`printf 'run\\n' >> counter.txt; printf 'COMMAND_CONTEXT'`",
          "system.txt": "SYSTEM_CONTEXT",
        },
        prompts: ["FIRST_SESSION_ONLY", "same session"],
        freshPrompts: ["new session", "another fresh turn"],
      },
      {
        turns: [
          {
            attachments: ['<file path="system.txt">\nSYSTEM_CONTEXT\n</file>'],
            systemIncludes: ["COMMAND_CONTEXT"],
          },
          {
            attachments: ['<file path="system.txt">\nSYSTEM_CONTEXT\n</file>'],
            systemIncludes: ["COMMAND_CONTEXT"],
          },
          {
            attachments: ['<file path="system.txt">\nSYSTEM_CONTEXT\n</file>'],
            systemIncludes: ["COMMAND_CONTEXT"],
            textExcludes: /FIRST_SESSION_ONLY/,
          },
          {
            attachments: ['<file path="system.txt">\nSYSTEM_CONTEXT\n</file>'],
            systemIncludes: ["COMMAND_CONTEXT"],
            textExcludes: /FIRST_SESSION_ONLY/,
          },
        ],
        filesBefore: { "counter.txt": "run\n" },
        filesAfter: { "counter.txt": "run\nrun\n" },
        replacement: { cancelled: false },
        changedId: true,
        freshHistory: [],
      },
      { t },
    ));

  test("switching to a persisted session resumes context on the next real model turn without replaying user commands", async (t) =>
    assertResumedSession(
      {
        files: { "context.txt": "ORIGINAL_CONTEXT" },
        prompts: ["ORIGINAL_SESSION @context.txt !`printf 'run\\n' >> counter.txt; printf 'COMMAND_CONTEXT'`"],
        otherPrompt: "OTHER_SESSION_ONLY",
        updatedFiles: { "context.txt": "UPDATED_CONTEXT" },
        resumedPrompt: "RESUMED_TURN @context.txt",
      },
      {
        turn: {
          attachments: [
            "<bash command=\"printf 'run\\n' >> counter.txt; printf 'COMMAND_CONTEXT'\">\nCOMMAND_CONTEXT\n</bash>",
            '<file path="context.txt">\nORIGINAL_CONTEXT\n</file>',
            '<file path="context.txt">\nUPDATED_CONTEXT\n</file>',
          ],
          textExcludes: /OTHER_SESSION_ONLY/,
        },
        files: { "counter.txt": "run\n" },
        replacement: { cancelled: false },
        resumed: { cancelled: false },
        restoredId: true,
      },
      { t },
    ));

  test("SDK reload retains history and reloads resolver settings before the next model turn", async (t) =>
    assertReloadedSession(
      {
        projectSettings: JSON.stringify({ sources: { userInput: { files: false } } }),
        files: { "context.txt": "AFTER_RELOAD_CONTEXT" },
        prompts: ["BEFORE_RELOAD @context.txt"],
        reloadedSettings: "{}",
        nextPrompt: "AFTER_RELOAD @context.txt",
      },
      {
        before: { attachments: [], textExcludes: /AFTER_RELOAD_CONTEXT/ },
        after: {
          attachments: ['<file path="context.txt">\nAFTER_RELOAD_CONTEXT\n</file>'],
          textIncludes: ["BEFORE_RELOAD @context.txt"],
        },
        sameId: true,
        extensionErrors: [],
      },
      { t },
    ));
});

describe("Extension and tool consumers", () => {
  test("extension-injected prompts remain inert without shared-resolver opt-in", async (t) =>
    assertInjectedPrompt(
      { files: { "secret.md": "SECRET_MUST_NOT_BE_ATTACHED" }, prompt: '@secret.md !`touch forbidden`' },
      { turn: { attachments: [], textExcludes: /SECRET_MUST_NOT_BE_ATTACHED/ }, files: { forbidden: null } },
      { t },
    ));

  test("extension-injected first prompts still receive independent system context", async (t) =>
    assertInjectedPrompt(
      {
        files: {
          "AGENTS.md": '@system.md !`printf SYSTEM_COMMAND`',
          "system.md": "SYSTEM_CONTEXT",
          "secret.md": "SECRET_MUST_NOT_BE_ATTACHED",
        },
        prompt: '@secret.md !`touch forbidden`',
      },
      {
        turn: {
          attachments: ['<file path="system.md">\nSYSTEM_CONTEXT\n</file>'],
          textExcludes: /SECRET_MUST_NOT_BE_ATTACHED/,
          systemIncludes: ["SYSTEM_COMMAND"],
        },
        files: { forbidden: null },
      },
      { t },
    ));

  test("extension-injected templates cannot fall back to automatic template resolution", async (t) =>
    assertInjectedPrompt(
      {
        files: { "secret.md": "SECRET_MUST_NOT_BE_ATTACHED", ".pi/prompts/injected.md": '@secret.md !`touch forbidden`' },
        projectSettings: JSON.stringify({ defaults: { commands: true } }),
        prompt: "/injected", expandPromptTemplates: true,
      },
      { turn: { attachments: [], textExcludes: /SECRET_MUST_NOT_BE_ATTACHED/ }, files: { forbidden: null } },
      { t },
    ));

  test("extension-injected skills remain inert even when skill and extension commands are enabled", async (t) =>
    assertInjectedPrompt(
      {
        files: {
          ".pi/skills/injected/SKILL.md": '---\nname: injected\ndescription: fixture\n---\n@secret.md !`touch forbidden`',
          ".pi/skills/injected/secret.md": "SECRET_MUST_NOT_BE_ATTACHED",
        },
        projectSettings: JSON.stringify({ defaults: { commands: true } }),
        prompt: "/skill:injected", expandPromptTemplates: true,
      },
      { turn: { attachments: [], textExcludes: /SECRET_MUST_NOT_BE_ATTACHED/ }, files: { forbidden: null } },
      { t },
    ));

  const files = { "note.md": "CONSUMER_CONTENT", "secret.md": "MUST_NOT_ATTACH", "large.md": "x".repeat(100_001) };

  test("extension command explicitly propagates extension-policy context and failures to its model call without resolver UI", async (t) =>
    assertExtensionConsumer(
      {
        files,
        projectSettings: JSON.stringify({
          sources: { userInput: { files: false, commands: false }, extension: { commands: true, display: "always" } },
        }),
        prompts: ["/consumer @note.md @missing.md @large.md !`printf x >> consumer-count; printf COMMAND_OUTPUT` !`exit 8`"],
      },
      {
        turn: {
          attachments: [
            '<file path="note.md">\nCONSUMER_CONTENT\n</file>',
            '<bash command="printf x >> consumer-count; printf COMMAND_OUTPUT">\nCOMMAND_OUTPUT\n</bash>',
          ],
        },
        statuses: ["success", "missing", "oversized", "success", "error"],
        files: { "consumer-count": "x" },
        requests: 1,
        messageRoles: ["consumer-result"],
      },
      { t },
    ));

  test("files-only tool resolution suppresses commands even when extension policy enables them", async (t) =>
    assertToolConsumer(
      {
        files,
        mode: "files",
        text: "@note.md !`printf x >> tool-count; printf TOOL_OUTPUT`",
        projectSettings: JSON.stringify({
          sources: {
            userInput: { files: false, commands: false },
            extension: { files: true, commands: true, display: "always" },
          },
        }),
      },
      {
        statuses: ["success", "disabled"],
        context: ['<file path="note.md">\nCONSUMER_CONTENT\n</file>'],
        requests: 2,
        customMessages: 0,
        files: { "tool-count": null },
      },
      { t },
    ));

  test("all-mode tool resolution propagates file and command context when extension policy allows both", async (t) =>
    assertToolConsumer(
      {
        files,
        mode: "all",
        text: "@note.md !`printf x >> tool-count; printf TOOL_OUTPUT`",
        projectSettings: JSON.stringify({
          sources: {
            userInput: { files: false, commands: false },
            extension: { files: true, commands: true, display: "always" },
          },
        }),
      },
      {
        statuses: ["success", "success"],
        context: [
          '<file path="note.md">\nCONSUMER_CONTENT\n</file>',
          '<bash command="printf x >> tool-count; printf TOOL_OUTPUT">\nTOOL_OUTPUT\n</bash>',
        ],
        requests: 2,
        customMessages: 0,
        files: { "tool-count": "x" },
      },
      { t },
    ));

  test("arbitrary tool output stays inert with all resolver capabilities enabled", async (t) =>
    assertRawTool(
      { files, prompt: "Use the raw fixture tool" },
      {
        turn: {
          attachments: [],
          textIncludes: ["@secret.md !`touch forbidden`"],
          textExcludes: /MUST_NOT_ATTACH|<file path=|<bash command=/,
        },
        files: { forbidden: null },
        customMessages: 0,
      },
      { t },
    ));
});
