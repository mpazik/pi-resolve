import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import consumerExtension from "./fixtures/consumer-extension.mock.ts";
import { createHarness, contextTexts } from "./fixtures/session.mock.ts";
import { createResolverHarness } from "./fixtures/resolver.mock.ts";

const files = {
  "note.md": "PROJECT_NOTE",
  "library/z.md": "CHILD_MUST_NOT_BE_READ",
  "library/a.md": "@secret.md",
  "library/nested/hidden.md": "NESTED_MUST_NOT_BE_READ",
  "secret.md": "SECRET_MUST_NOT_BE_ATTACHED",
};

const listing = '<file path="library/">\nDirectory listing (immediate entries):\na.md\nnested/\nz.md\n</file>';

const directoryFiles = {
  "docs/aaaaaaaaaaaaaaaaaaaa.md": "not imported",
  "docs/bbbbbbbbbbbbbbbbbbbb.md": "not imported",
  "docs/cccccccccccccccccccc.md": "not imported",
};

describe("Direct input and persistence", () => {
  test("typed prompts preserve text, attach once, keep imports inert, and persist across turns", async (t) => {
    const h = await createHarness(t, { persist: true, files: {
      ...files,
      "import.md": '@secret.md !`touch forbidden`',
      "output.txt": '@secret.md !`touch forbidden`',
    } });
    const prompt = '@note.md @./note.md @library/ @import.md !`printf x >> count; cat output.txt`\n`@secret.md`\n```\n@secret.md !`touch forbidden`\n```';
    const first = contextTexts(await h.prompt(prompt));
    assert.ok(first.includes(prompt));
    assert.equal(first.filter((text) => text.includes("PROJECT_NOTE")).length, 1);
    assert.ok(first.includes(listing));
    assert.ok(first.includes('<file path="import.md">\n@secret.md !`touch forbidden`\n</file>'));
    assert.ok(first.includes('<bash command="printf x >> count; cat output.txt">\n@secret.md !`touch forbidden`\n</bash>'));
    assert.doesNotMatch(first.join("\n"), /SECRET_MUST_NOT_BE_ATTACHED|CHILD_MUST_NOT_BE_READ|NESTED_MUST_NOT_BE_READ/);
    const second = contextTexts(await h.prompt('second !`printf x >> count; printf SECOND`'));
    assert.ok(second.includes(prompt));
    assert.equal(second.filter((text) => text.includes("PROJECT_NOTE")).length, 1);
    assert.equal(await readFile(join(h.cwd, "count"), "utf8"), "xx");
    await assert.rejects(readFile(join(h.cwd, "forbidden")), { code: "ENOENT" });
    const users = h.session.messages.filter((message) => message.role === "user");
    assert.deepEqual(users[0]?.content, [{ type: "text", text: prompt }]);
    const transcript = (await readFile(h.sessionManager.getSessionFile()!, "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line))
      .filter((entry) => entry.type === "message").map((entry) => entry.message);
    assert.deepEqual(transcript, JSON.parse(JSON.stringify(h.session.messages.filter((message) => message.role !== "custom"))));
    const restored = SessionManager.open(h.sessionManager.getSessionFile()!).buildSessionContext().messages;
    // Pi stamps custom transcript entries separately from in-memory messages.
    const withoutTimestamps = (messages: typeof restored) => JSON.parse(JSON.stringify(
      messages.map(({ timestamp: _timestamp, ...message }) => message),
    ));
    assert.deepEqual(withoutTimestamps(restored), withoutTimestamps(h.session.messages));
    assert.equal(restored.filter((message) => message.role === "custom").length, 2);
    assert.equal(transcript.filter((message) => message.role === "assistant").length, 2);
  });
});

describe("Templates and skills", () => {
  test("real skill expansion uses skill files, project commands, trailing args, and substitutions", async (t) => {
    const h = await createHarness(t, { projectSettings: JSON.stringify({ sources: { skill: { commands: true } } }), files: {
      ...files,
      ".pi/skills/demo/SKILL.md": '---\nname: demo\ndescription: Resolver fixture\n---\n@note.md @library/ @arg-$0.md\n!`printf x >> skill-count; unset UNSET_FIXTURE; printf "%s" "$ARGUMENTS|$ARGUMENTS[0]|$0|$1|$9|${UNSET_FIXTURE:-fallback}"; pwd`',
      ".pi/skills/demo/note.md": "SKILL_NOTE",
      ".pi/skills/demo/arg-alpha.md": "SUBSTITUTED_FILE",
      ".pi/skills/demo/library/z.md": "CHILD_MUST_NOT_BE_READ",
      ".pi/skills/demo/library/a.md": "unused",
      ".pi/skills/demo/library/nested/hidden.md": "unused",
    } });
    assert.equal(h.resourceLoader.getSkills().skills[0]?.name, "demo");
    const texts = contextTexts(await h.prompt("/skill:demo alpha @note.md"));
    assert.ok(texts.includes('<file path="note.md">\nSKILL_NOTE\n</file>'));
    assert.ok(texts.includes('<file path="arg-alpha.md">\nSUBSTITUTED_FILE\n</file>'));
    assert.ok(texts.includes('<file path="note.md">\nPROJECT_NOTE\n</file>'));
    assert.ok(texts.includes(listing));
    assert.ok(texts.some((text) => text.includes(`alpha @note.md|alpha|alpha|@note.md||fallback${h.cwd}`)), texts.join("\n"));
    assert.equal(await readFile(join(h.cwd, "skill-count"), "utf8"), "x");
    assert.doesNotMatch(texts.join("\n"), /CHILD_MUST_NOT_BE_READ/);
  });

  test("real prompt templates resolve files, directories and substituted commands under template policy", async (t) => {
    const h = await createHarness(t, { projectSettings: JSON.stringify({ sources: { template: { commands: true } } }), files: {
      ...files,
      ".pi/prompts/demo.md": '---\ndescription: Resolver fixture\n---\n@note.md @library/ !`printf x >> template-count; printf "$1"`',
    } });
    assert.equal(h.resourceLoader.getPrompts().prompts[0]?.name, "demo");
    const texts = contextTexts(await h.prompt("/demo TEMPLATE_OUTPUT"));
    assert.ok(texts.includes('<file path="note.md">\nPROJECT_NOTE\n</file>'));
    assert.ok(texts.includes(listing));
    assert.ok(texts.includes('<bash command="printf x >> template-count; printf "TEMPLATE_OUTPUT"">\nTEMPLATE_OUTPUT\n</bash>'));
    assert.equal(await readFile(join(h.cwd, "template-count"), "utf8"), "x");
  });

  test("template expansion cannot re-enable disabled direct file occurrences", async (t) => {
    const h = await createHarness(t, {
      projectSettings: JSON.stringify({ sources: { userInput: { files: false } } }),
      files: {
        "sample.txt": "FORBIDDEN_DIRECT_FILE", "fresh.txt": "NEW_TEMPLATE_FILE",
        ".pi/prompts/demo.md": 'expanded $ARGUMENTS @fresh.txt',
      },
    });
    const texts = contextTexts(await h.prompt("/demo @sample.txt @sample.txt"));
    assert.deepEqual(texts.filter((text) => text.startsWith("<file ")), ['<file path="fresh.txt">\nNEW_TEMPLATE_FILE\n</file>']);
    assert.doesNotMatch(texts.join("\n"), /FORBIDDEN_DIRECT_FILE/);
  });

  test("identical template references conservatively retain disabled direct-input policy", async (t) => {
    const h = await createHarness(t, {
      projectSettings: JSON.stringify({ sources: { userInput: { files: false } } }),
      files: { "sample.txt": "TEMPLATE_FILE", ".pi/prompts/demo.md": '$ARGUMENTS @sample.txt' },
    });
    const texts = contextTexts(await h.prompt("/demo @sample.txt @sample.txt"));
    assert.deepEqual(texts.filter((text) => text.startsWith("<file ")), []);
    assert.doesNotMatch(texts.join("\n"), /TEMPLATE_FILE/);
  });

  test("skill trailing and substituted arguments retain disabled direct file policy without blocking skill files", async (t) => {
    const h = await createHarness(t, {
      projectSettings: JSON.stringify({ sources: { userInput: { files: false } } }),
      files: {
        "sample.txt": "FORBIDDEN_PROJECT_FILE",
        ".pi/skills/demo/sample.txt": "FORBIDDEN_SKILL_ARG_FILE",
        ".pi/skills/demo/own.txt": "SKILL_FILE",
        ".pi/skills/demo/arg-next.txt": "POSITION_PRESERVED",
        ".pi/skills/demo/SKILL.md": '---\nname: demo\ndescription: fixture\n---\n$ARGUMENTS $0 @own.txt @arg-$1.txt',
      },
    });
    const texts = contextTexts(await h.prompt("/skill:demo @sample.txt next"));
    assert.deepEqual(texts.filter((text) => text.startsWith("<file ")), [
      '<file path="own.txt">\nSKILL_FILE\n</file>',
      '<file path="arg-next.txt">\nPOSITION_PRESERVED\n</file>',
    ]);
    assert.doesNotMatch(texts.join("\n"), /FORBIDDEN_/);
  });

  test("duplicated template arguments cannot re-enable disabled direct files or commands", async (t) => {
    const h = await createHarness(t, {
      projectSettings: JSON.stringify({ sources: { userInput: { files: false, commands: false }, template: { commands: true } } }),
      files: {
        "sample.txt": "FORBIDDEN_FILE", "fresh.txt": "TEMPLATE_FILE",
        ".pi/prompts/demo.md": '$ARGUMENTS $ARGUMENTS @fresh.txt !`printf x >> template-count`',
      },
    });
    const texts = contextTexts(await h.prompt('/demo @sample.txt !`touch forbidden`'));
    assert.ok(texts.includes('<file path="fresh.txt">\nTEMPLATE_FILE\n</file>'));
    assert.doesNotMatch(texts.join("\n"), /FORBIDDEN_FILE/);
    assert.equal(await readFile(join(h.cwd, "template-count"), "utf8"), "x");
    await assert.rejects(readFile(join(h.cwd, "forbidden")), { code: "ENOENT" });
  });

  test("skill command opt-in cannot re-enable direct commands through repeated arguments", async (t) => {
    const h = await createHarness(t, {
      projectSettings: JSON.stringify({ sources: { userInput: { commands: false }, skill: { commands: true } } }),
      files: {
        ".pi/skills/demo/SKILL.md": '---\nname: demo\ndescription: fixture\n---\n$ARGUMENTS $ARGUMENTS !`printf x >> skill-count`',
      },
    });
    await h.prompt('/skill:demo !`touch forbidden`');
    assert.equal(await readFile(join(h.cwd, "skill-count"), "utf8"), "x");
    await assert.rejects(readFile(join(h.cwd, "forbidden")), { code: "ENOENT" });
  });

  test("template opt-in does not re-enable disabled commands originating in direct arguments", async (t) => {
    const h = await createHarness(t, {
      projectSettings: JSON.stringify({ sources: { userInput: { commands: false }, template: { commands: true } } }),
      files: { ".pi/prompts/demo.md": '$ARGUMENTS !`printf x >> template-count; printf TEMPLATE`' },
    });
    await h.prompt('/demo !`touch forbidden`');
    assert.equal(await readFile(join(h.cwd, "template-count"), "utf8"), "x");
    await assert.rejects(readFile(join(h.cwd, "forbidden")), { code: "ENOENT" });
  });
});

describe("System context", () => {
  test("loaded AGENTS context resolves once and command output stays inert", async (t) => {
    const h = await createHarness(t, { files: {
      ...files,
      "AGENTS.md": '@note.md @library/ !`printf x >> system-count; cat output.txt`',
      "output.txt": '@secret.md !`touch forbidden` SYSTEM_OUTPUT',
    } });
    assert.ok(h.resourceLoader.getAgentsFiles().agentsFiles.some((file) => file.path === join(h.cwd, "AGENTS.md")));
    const first = await h.prompt("first");
    assert.match(first.systemPrompt!, /SYSTEM_OUTPUT/);
    assert.ok(contextTexts(first).includes(listing));
    assert.doesNotMatch(contextTexts(first).join("\n"), /SECRET_MUST_NOT_BE_ATTACHED/);
    const second = await h.prompt("second");
    assert.match(second.systemPrompt!, /SYSTEM_OUTPUT/);
    assert.equal(contextTexts(second).filter((text) => text.includes("PROJECT_NOTE")).length, 1);
    assert.equal(await readFile(join(h.cwd, "system-count"), "utf8"), "x");
    await assert.rejects(readFile(join(h.cwd, "forbidden")), { code: "ENOENT" });
  });
});

describe("Turn budgets", () => {
  test("configured per-file limit preserves directory truncation with an omission count", async (t) => {
    const h = await createHarness(t, {
      projectSettings: JSON.stringify({ limits: { maxFileBytes: 100, maxTotalBytes: 1000 } }),
      files: directoryFiles,
    });
    const texts = contextTexts(await h.prompt("@docs/"));
    assert.ok(texts.includes('<file path="docs/">\nDirectory listing (immediate entries):\naaaaaaaaaaaaaaaaaaaa.md\n[truncated: 2 entries omitted]\n</file>'));
  });

  test("total budget omits a directory rather than further truncating its listing", async (t) => {
    const h = await createHarness(t, {
      projectSettings: JSON.stringify({ limits: { maxFileBytes: 200, maxTotalBytes: 110 } }),
      files: directoryFiles,
    });
    const texts = contextTexts(await h.prompt("@docs/"));
    assert.ok(texts.includes('<file path="docs/" status="oversized" reason="total byte budget exceeded" />'));
    assert.ok(!texts.some((text) => text.includes("Directory listing")));
  });

  test("turn total admits direct, system and template imports in order including wrappers", async (t) => {
    const h = await createHarness(t, {
      projectSettings: JSON.stringify({ limits: { maxTotalBytes: 59 } }),
      files: {
        "a.md": "A", "b.md": "B", "c.md": "C",
        "AGENTS.md": '!`printf SYS`',
        ".pi/prompts/demo.md": "@b.md @c.md",
      },
    });
    const request = await h.prompt("/demo @a.md");
    assert.ok(request.systemPrompt?.includes("SYS"));
    assert.deepEqual(contextTexts(request).filter((text) => text.startsWith("<file ")), [
      '<file path="a.md">\nA\n</file>',
      '<file path="b.md">\nB\n</file>',
      '<file path="c.md" status="oversized" reason="total byte budget exceeded" />',
    ]);
  });

  test("cached system output counts each turn without reexecution or redundant cache charges", async (t) => {
    const command = 'printf x >> count; printf SYS';
    const h = await createHarness(t, {
      projectSettings: JSON.stringify({ limits: { maxTotalBytes: 31 } }),
      files: { "a.md": "A", "big.md": "AB", "AGENTS.md": `!\`${command}\`` },
    });
    const first = await h.prompt("@a.md");
    assert.ok(first.systemPrompt?.includes("SYS"));
    assert.ok(!first.systemPrompt?.includes(`!\`${command}\``));
    const second = await h.prompt("@big.md");
    assert.ok(second.systemPrompt?.includes(`!\`${command}\``));
    assert.ok(contextTexts(second).includes('<bash command="printf x &gt;&gt; count; printf SYS" status="oversized" reason="total byte budget exceeded" />'));
    const third = await h.prompt("plain prompt");
    assert.ok(!third.systemPrompt?.includes(`!\`${command}\``));
    assert.equal(await readFile(join(h.cwd, "count"), "utf8"), "x");
  });

  test("file deduplication and failures do not consume successful payload capacity", async (t) => {
    const h = await createHarness(t, {
      projectSettings: JSON.stringify({ limits: { maxFileBytes: 2, maxTotalBytes: 56 } }),
      files: { "a.md": "A", "b.md": "B", "large.md": "XXX" },
    });
    const texts = contextTexts(await h.prompt("@large.md @missing.md @a.md @./a.md @b.md"));
    assert.deepEqual(texts.filter((text) => text.startsWith("<file ")), [
      '<file path="large.md" status="oversized" reason="file exceeds size limit" />',
      '<file path="missing.md" status="missing" reason="file not found" />',
      '<file path="a.md">\nA\n</file>',
      '<file path="b.md">\nB\n</file>',
    ]);
  });

  test("turn budget omits commands that cannot fit without starting their side effects", async (t) => {
    const h = await createHarness(t, {
      projectSettings: JSON.stringify({ limits: { maxTotalBytes: 28 } }),
      files: { "a.md": "A" },
    });
    const texts = contextTexts(await h.prompt('@a.md !`touch forbidden`'));
    assert.ok(texts.includes('<bash command="touch forbidden" status="oversized" reason="total byte budget exceeded" />'));
    await assert.rejects(readFile(join(h.cwd, "forbidden")), { code: "ENOENT" });
  });

  test("skill imports share the direct and system budget and omitted commands never start", async (t) => {
    const h = await createHarness(t, {
      projectSettings: JSON.stringify({ limits: { maxTotalBytes: 59 }, sources: { skill: { commands: true } } }),
      files: {
        "a.md": "A", "AGENTS.md": '!`printf SYS`',
        ".pi/skills/demo/SKILL.md": '---\nname: demo\ndescription: fixture\n---\n@b.md !`touch forbidden`',
        ".pi/skills/demo/b.md": "B",
      },
    });
    const texts = contextTexts(await h.prompt("/skill:demo @a.md"));
    assert.ok(texts.includes('<file path="a.md">\nA\n</file>'));
    assert.ok(texts.includes('<file path="b.md">\nB\n</file>'));
    assert.ok(texts.includes('<bash command="touch forbidden" status="oversized" reason="total byte budget exceeded" />'));
    await assert.rejects(readFile(join(h.cwd, "forbidden")), { code: "ENOENT" });
  });

  test("safe-integer limits read small files without allocating the configured capacity", async (t) => {
    const h = await createHarness(t, {
      projectSettings: JSON.stringify({ limits: { maxFileBytes: Number.MAX_SAFE_INTEGER, maxTotalBytes: Number.MAX_SAFE_INTEGER } }),
      files: { "a.md": "A" },
    });
    assert.ok(contextTexts(await h.prompt("@a.md")).includes('<file path="a.md">\nA\n</file>'));
  });

  test("tiny budgets still report safe explicitly shortened failure references", async (t) => {
    const h = await createHarness(t, { projectSettings: JSON.stringify({ limits: { maxTotalBytes: 1 } }) });
    const texts = contextTexts(await h.prompt(`!\`printf ${"x".repeat(2000)}\``));
    const markers = texts.filter((text) => text.startsWith("<bash "));
    assert.equal(markers.length, 1);
    assert.match(markers[0]!, /\[reference shortened\].*reason="total byte budget exceeded"/);
    assert.ok(Buffer.byteLength(markers[0]!, "utf8") < 400);
  });
});

describe("Source policy", () => {
  test("templates and skills default to files only while direct and AGENTS commands remain enabled", async (t) => {
    const h = await createHarness(t, { files: {
      "a.md": "A", "AGENTS.md": '!`printf x >> system-count; printf SYS`',
      ".pi/prompts/demo.md": '@a.md !`touch template-forbidden`',
      ".pi/skills/demo/SKILL.md": '---\nname: demo\ndescription: fixture\n---\n@note.md !`touch skill-forbidden`',
      ".pi/skills/demo/note.md": "SKILL_FILE",
    } });
    await h.prompt('!`printf x >> direct-count; printf DIRECT`');
    const direct = h.session.messages.filter((message) => message.role === "custom").at(-1);
    assert.ok(direct?.role === "custom");
    assert.deepEqual((direct.details as { items: { label: string }[] }).items.map(({ label }) => label), ['printf x >> direct-count; printf DIRECT']);
    await h.prompt("/demo");
    const template = h.session.messages.filter((message) => message.role === "custom").at(-1);
    assert.ok(template?.role === "custom");
    assert.deepEqual((template.details as { items: { label: string }[] }).items.map(({ label }) => label), ["a.md"]);
    const skillRequest = await h.prompt("/skill:demo");
    assert.ok(contextTexts(skillRequest).includes('<file path="note.md">\nSKILL_FILE\n</file>'));
    const skill = h.session.messages.filter((message) => message.role === "custom").at(-1);
    assert.ok(skill?.role === "custom");
    assert.deepEqual(skill.details, { items: [] });
    assert.equal(skill.display, false);
    assert.equal(await readFile(join(h.cwd, "system-count"), "utf8"), "x");
    assert.equal(await readFile(join(h.cwd, "direct-count"), "utf8"), "x");
    await assert.rejects(readFile(join(h.cwd, "template-forbidden")), { code: "ENOENT" });
    await assert.rejects(readFile(join(h.cwd, "skill-forbidden")), { code: "ENOENT" });
  });

  test("disabled files and commands add no context and have no side effects across source paths", async (t) => {
    const body = '@ok.md !`touch forbidden`';
    const h = await createHarness(t, {
      globalSettings: JSON.stringify({ defaults: { files: false, commands: false } }),
      projectSettings: JSON.stringify({ defaults: { display: "never" } }),
      files: {
        "ok.md": "MUST_NOT_ATTACH", "AGENTS.md": body,
        ".pi/skills/demo/SKILL.md": `---\nname: demo\ndescription: fixture\n---\n${body}`,
        ".pi/prompts/demo.md": body,
      },
    });
    for (const prompt of [body, "/skill:demo", "/demo"]) {
      const request = await h.prompt(prompt);
      assert.doesNotMatch(contextTexts(request).join("\n"), /MUST_NOT_ATTACH|<file path=|<bash command=/);
    }
    assert.equal(h.session.messages.filter((message) => message.role === "custom").length, 0);
    await assert.rejects(readFile(join(h.cwd, "forbidden")), { code: "ENOENT" });
  });

  test("malformed JSON and invalid values warn without leaking values and retain inherited policy", async (t) => {
    const warnings: string[] = [];
    t.mock.method(console, "error", (...args: unknown[]) => warnings.push(args.join(" ")));
    const h = await createHarness(t, {
      globalSettings: '{"PRIVATE_MALFORMED_VALUE":',
      projectSettings: JSON.stringify({ defaults: { commands: "PRIVATE_INVALID_VALUE" }, PRIVATE_KEY: "PRIVATE_VALUE" }),
    });
    const texts = contextTexts(await h.prompt('!`printf ALLOWED`'));
    assert.ok(texts.includes('<bash command="printf ALLOWED">\nALLOWED\n</bash>'));
    assert.equal(warnings.length, 3);
    assert.match(warnings.join("\n"), /Unable to read or parse/);
    assert.match(warnings.join("\n"), /invalid-value/);
    assert.match(warnings.join("\n"), /unknown-key/);
    assert.doesNotMatch(warnings.join("\n"), /PRIVATE/);
  });

  for (const source of ["userInput", "systemPrompt", "skill", "template"] as const) {
    for (const capability of ["files", "commands"] as const) {
      test(`${source}: disabling ${capability} preserves the other capability`, async (t) => {
        const body = '@./note.md @./docs/ !`printf x >> executed; printf COMMAND_ALLOWED`';
        const h = await createHarness(t, {
          projectSettings: JSON.stringify({ sources: { [source]: { files: true, commands: true, [capability]: false } } }),
          files: {
            "note.md": "FILE_ALLOWED",
            "docs/entry.md": "DIRECTORY_CONTENT_MUST_STAY_UNREAD",
            ...(source === "systemPrompt" ? { "AGENTS.md": body } : {}),
            ...(source === "template" ? { ".pi/prompts/demo.md": body } : {}),
            ...(source === "skill" ? {
              ".pi/skills/demo/SKILL.md": `---\nname: demo\ndescription: fixture\n---\n${body}`,
              ".pi/skills/demo/note.md": "FILE_ALLOWED",
              ".pi/skills/demo/docs/entry.md": "DIRECTORY_CONTENT_MUST_STAY_UNREAD",
            } : {}),
          },
        });
        const request = await h.prompt(source === "skill" ? "/skill:demo" : source === "template" ? "/demo" : source === "systemPrompt" ? "Check context" : body);
        const texts = contextTexts(request).join("\n");
        if (capability === "files") {
          assert.doesNotMatch(texts, /FILE_ALLOWED|entry\.md/);
          assert.equal(await readFile(join(h.cwd, "executed"), "utf8"), "x");
        } else {
          assert.match(texts, /FILE_ALLOWED/);
          assert.match(texts, /entry\.md/);
          await assert.rejects(readFile(join(h.cwd, "executed")), { code: "ENOENT" });
        }
        assert.doesNotMatch(texts, /DIRECTORY_CONTENT_MUST_STAY_UNREAD/);
      });
    }
  }

  for (const projectSettings of [
    JSON.stringify({ sources: { userInput: { display: "never" } } }),
    JSON.stringify({ sources: { userInput: { commands: "PRIVATE_INVALID", display: "never" } } }),
    '{"PRIVATE_MALFORMED":',
  ]) {
    test(`project override retains global source command restriction: ${projectSettings}`, async (t) => {
      const warnings: string[] = [];
      t.mock.method(console, "error", (...args: unknown[]) => warnings.push(args.join(" ")));
      const h = await createHarness(t, {
        globalSettings: JSON.stringify({ sources: { userInput: { commands: false } } }),
        projectSettings,
        files: { "note.md": "INHERITED_FILE_ALLOWED" },
      });
      const texts = contextTexts(await h.prompt('@note.md !`touch forbidden`'));
      assert.ok(texts.includes('<file path="note.md">\nINHERITED_FILE_ALLOWED\n</file>'));
      await assert.rejects(readFile(join(h.cwd, "forbidden")), { code: "ENOENT" });
      assert.doesNotMatch(warnings.join("\n"), /PRIVATE/);
    });
  }
});

describe("Display", () => {
  for (const display of ["always", "errors", "never"] as const) {
    test(`${display} filters summary items, not provider context`, async (t) => {
      const h = await createHarness(t, {
        files: { "ok.md": "MODEL_CONTENT", "large.md": "x".repeat(100_001) },
        projectSettings: JSON.stringify({ defaults: { display } }),
      });
      const texts = contextTexts(await h.prompt("@ok.md @missing.md @large.md !`printf FAILED >&2; exit 7`"));
      assert.ok(texts.includes('<file path="ok.md">\nMODEL_CONTENT\n</file>'));
      assert.equal(texts.filter((text) => text.startsWith("<file ")).length, 3);
      const summary = h.session.messages.find((message) => message.role === "custom" && message.customType === "context");
      assert.ok(summary && summary.role === "custom");
      const details = summary.details as { items: { result: string; label: string }[] };
      assert.deepEqual(details.items.map((item) => item.result), display === "always"
        ? ["error", "ok", "error", "skipped"] : display === "errors" ? ["error", "error", "skipped"] : []);
      const renderer = h.resourceLoader.getExtensions().extensions[0]?.messageRenderers.get("context");
      assert.ok(renderer);
      initTheme("dark", false);
      const component = renderer(summary, { expanded: false, outputPad: 0 }, h.theme);
      if (display === "never") assert.equal(component, undefined);
      else {
        assert.ok(component);
        const rendered = component.render(200).map(stripVTControlCharacters).join("\n");
        assert.match(rendered, /missing\.md/);
        assert.match(rendered, /ignored/);
        if (display === "always") assert.match(rendered, /ok\.md/);
        else assert.doesNotMatch(rendered, /ok\.md/);
      }
      await h.prompt("@ok.md");
      const successOnly = h.session.messages.filter((message) => message.role === "custom").at(-1);
      assert.ok(successOnly?.role === "custom");
      assert.equal(renderer(successOnly, { expanded: false, outputPad: 0 }, h.theme) !== undefined, display === "always");
    });
  }

  test("typed command loader is shown and cleared on successful resolution", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const resolver = createResolverHarness();
    const widgets: string[] = [];
    const rendered: string[] = [];
    let renders = 0;
    await resolver.handlers.get("input")!({ text: '!`printf OK`' }, {
      hasUI: true, ui: { setWidget: (name: string, widget?: (
        tui: { requestRender(): void }, theme: { fg(color: string, text: string): string },
      ) => { render(width: number): string[] }) => {
        widgets.push(`${name}:${typeof widget}`);
        if (widget) {
          const component = widget({ requestRender: () => { renders++; } }, { fg: (_color, text) => text });
          rendered.push(...component.render(200));
        }
      } },
    });
    assert.deepEqual(widgets, ["pi-resolve:function", "pi-resolve:undefined"]);
    assert.match(rendered.join("\n"), /printf OK/);
    const completedRenders = renders;
    assert.ok(completedRenders > 0);
    t.mock.timers.tick(160);
    assert.equal(renders, completedRenders, "cleared loader must stop requesting redraws");
    const result = await resolver.handlers.get("before_agent_start")!({ prompt: '!`printf OK`', systemPrompt: "" });
    assert.deepEqual(result.message.content, [{ type: "text", text: '<bash command="printf OK">\nOK\n</bash>' }]);
  });

  test("typed command loader is cleared when command resolution fails", async (t) => {
    t.mock.method(console, "error", () => {});
    const resolver = createResolverHarness();
    const widgets: string[] = [];
    await resolver.handlers.get("input")!({ text: '!`exit 7`' }, {
      hasUI: true, ui: { setWidget: (name: string, widget: unknown) => widgets.push(`${name}:${typeof widget}`) },
    });
    assert.deepEqual(widgets, ["pi-resolve:function", "pi-resolve:undefined"]);
    const result = await resolver.handlers.get("before_agent_start")!({ prompt: '!`exit 7`', systemPrompt: "" });
    assert.deepEqual(result.message.content, [{ type: "text", text: '<bash command="exit 7" status="error" reason="command failed" />' }]);
  });
});

describe("Failure context", () => {
  test("command timeout completes the turn and kills command side effects", { timeout: 20_000 }, async (t) => {
    const h = await createHarness(t);
    const texts = contextTexts(await h.prompt('!`printf x >> started; sleep 30; touch forbidden`'));
    assert.equal(await readFile(join(h.cwd, "started"), "utf8"), "x");
    await assert.rejects(readFile(join(h.cwd, "forbidden")), { code: "ENOENT" });
    assert.deepEqual(texts.filter((text) => text.startsWith("<bash ")), [
      '<bash command="printf x &gt;&gt; started; sleep 30; touch forbidden" status="error" reason="command failed" />',
    ]);
    const summary = h.session.messages.find((message) => message.role === "custom");
    assert.ok(summary?.role === "custom");
    assert.deepEqual((summary.details as { items: { result: string }[] }).items.map((item) => item.result), ["error"]);
  });

  test("oversized command output is skipped without entering provider context", async (t) => {
    const h = await createHarness(t);
    const request = await h.prompt('!`head -c 100001 /dev/zero | tr "\\0" x`');
    const markers = contextTexts(request).filter((text) => text.startsWith("<bash "));
    assert.equal(markers.length, 1);
    assert.match(markers[0]!, /status="oversized" reason="command output exceeds size limit" \/>$/);
    assert.doesNotMatch(markers[0]!, /x{100}/);
    const summary = h.session.messages.find((message) => message.role === "custom");
    assert.ok(summary?.role === "custom");
    assert.deepEqual((summary.details as { items: { result: string }[] }).items.map((item) => item.result), ["skipped"]);
  });

  for (const source of ["userInput", "systemPrompt", "skill", "template"] as const) {
    test(`${source}: failures reach the provider with display never and no captured payload`, async (t) => {
      t.mock.method(console, "error", () => {});
      const body = '@ok.md @missing.md @large.md @ok.md/child !`sh fail.sh` !`sh overflow.sh` !`printf SUCCESS`';
      const files = {
        "ok.md": "ORIGINAL_SUCCESS\n",
        "large.md": "PRIVATE_FILE_PAYLOAD".repeat(10_000),
      };
      const h = await createHarness(t, {
        projectSettings: JSON.stringify({ defaults: { display: "never" }, sources: { skill: { commands: true }, template: { commands: true } } }),
        files: {
          ...files,
          "fail.sh": "printf PRIVATE_STDOUT; printf PRIVATE_STDERR >&2; exit 7",
          "overflow.sh": "printf PRIVATE_OVERFLOW; head -c 100001 /dev/zero",
          ...(source === "systemPrompt" ? { "AGENTS.md": body } : {}),
          ...(source === "template" ? { ".pi/prompts/demo.md": body } : {}),
          ...(source === "skill" ? {
            ".pi/skills/demo/SKILL.md": `---\nname: demo\ndescription: fixture\n---\n${body}`,
            ".pi/skills/demo/ok.md": files["ok.md"],
            ".pi/skills/demo/large.md": files["large.md"],
          } : {}),
        },
      });
      const request = await h.prompt(source === "skill" ? "/skill:demo" : source === "template" ? "/demo" : source === "systemPrompt" ? "Check context" : body);
      const texts = contextTexts(request);
      assert.ok(texts.includes('<file path="ok.md">\nORIGINAL_SUCCESS\n\n</file>'));
      assert.deepEqual(texts.filter((text) => text.includes(' status="')).sort(), [
        '<file path="missing.md" status="missing" reason="file not found" />',
        '<file path="large.md" status="oversized" reason="file exceeds size limit" />',
        '<file path="ok.md/child" status="error" reason="unable to read file" />',
        '<bash command="sh fail.sh" status="error" reason="command failed" />',
        '<bash command="sh overflow.sh" status="oversized" reason="command output exceeds size limit" />',
      ].sort());
      assert.doesNotMatch(texts.join("\n"), /PRIVATE_|ENOTDIR|not a directory/);
      if (source === "systemPrompt") {
        assert.ok(request.systemPrompt?.includes('!`sh fail.sh`'));
        assert.ok(request.systemPrompt?.includes('!`sh overflow.sh`'));
        assert.ok(request.systemPrompt?.includes("SUCCESS"));
        assert.ok(!texts.some((text) => text.startsWith('<bash command="printf SUCCESS"')));
      } else {
        assert.ok(texts.includes('<bash command="printf SUCCESS">\nSUCCESS\n</bash>'));
      }
      const summary = h.session.messages.find((message) => message.role === "custom" && message.customType === "context");
      assert.ok(summary?.role === "custom");
      assert.deepEqual(summary.details, { items: [] });
    });
  }
});

describe("Session lifecycle", () => {
  const command = "printf 'run\\n' >> counter.txt; printf 'COMMAND_CONTEXT'";

  const commandRef = `!\`${command}\``;

  // README promises first-turn system resolution. Resume/reload command cache
  // lifetime is not specified, so those cases deliberately use file context only.
  test("new SDK session clears history and runs system commands once in each fresh session", async (t) => {
    const h = await createHarness(t, {
      persist: true,
      files: { "AGENTS.md": `@system.txt\n${commandRef}`, "system.txt": "SYSTEM_CONTEXT" },
    });
    const runtime = h.lifecycle();
    const firstId = h.sessionManager.getSessionId();
    const first = await h.prompt("FIRST_SESSION_ONLY");
    assert.ok(first.systemPrompt?.includes("COMMAND_CONTEXT"));
    assert.ok(contextTexts(first).some((text) => text.includes("SYSTEM_CONTEXT")));
    const second = await h.prompt("same session");
    assert.ok(second.systemPrompt?.includes("COMMAND_CONTEXT"));
    assert.equal(await readFile(join(h.cwd, "counter.txt"), "utf8"), "run\n");

    assert.deepEqual(await runtime.newSession(), { cancelled: false });
    assert.notEqual(h.sessionManager.getSessionId(), firstId);
    assert.deepEqual(h.session.messages, []);
    const fresh = await h.prompt("new session");
    assert.ok(!contextTexts(fresh).includes("FIRST_SESSION_ONLY"));
    assert.ok(fresh.systemPrompt?.includes("COMMAND_CONTEXT"));
    assert.ok(contextTexts(fresh).some((text) => text.includes("SYSTEM_CONTEXT")));
    await h.prompt("another fresh turn");
    assert.equal(await readFile(join(h.cwd, "counter.txt"), "utf8"), "run\nrun\n");
  });

  test("switching to a persisted session resumes context on the next real model turn without replaying user commands", async (t) => {
    const h = await createHarness(t, {
      persist: true, files: { "context.txt": "ORIGINAL_CONTEXT" },
    });
    const runtime = h.lifecycle();
    await h.prompt(`ORIGINAL_SESSION @context.txt ${commandRef}`);
    const originalPath = h.sessionManager.getSessionFile();
    assert.ok(originalPath);
    const originalId = h.sessionManager.getSessionId();
    assert.deepEqual(await runtime.newSession(), { cancelled: false });
    await h.prompt("OTHER_SESSION_ONLY");
    assert.deepEqual(await runtime.switchSession(originalPath), { cancelled: false });
    assert.equal(h.sessionManager.getSessionId(), originalId);
    await writeFile(join(h.cwd, "context.txt"), "UPDATED_CONTEXT");
    const resumed = await h.prompt("RESUMED_TURN @context.txt");
    const texts = contextTexts(resumed);
    assert.ok(texts.some((text) => text.includes("ORIGINAL_CONTEXT")));
    assert.ok(texts.some((text) => text.includes("UPDATED_CONTEXT")));
    assert.ok(texts.some((text) => text.includes("\nCOMMAND_CONTEXT\n")));
    assert.ok(!texts.includes("OTHER_SESSION_ONLY"));
    assert.equal(await readFile(join(h.cwd, "counter.txt"), "utf8"), "run\n");
  });

  test("SDK reload retains history and reloads resolver settings before the next model turn", async (t) => {
    const h = await createHarness(t, {
      persist: true,
      projectSettings: JSON.stringify({ sources: { userInput: { files: false } } }),
      files: { "context.txt": "AFTER_RELOAD_CONTEXT" },
    });
    const first = await h.prompt("BEFORE_RELOAD @context.txt");
    assert.ok(!contextTexts(first).some((text) => text.includes("AFTER_RELOAD_CONTEXT")));
    const id = h.sessionManager.getSessionId();
    await writeFile(join(h.cwd, ".pi/pi-resolve.json"), "{}");
    await h.session.reload();
    assert.equal(h.sessionManager.getSessionId(), id);
    const next = await h.prompt("AFTER_RELOAD @context.txt");
    assert.ok(contextTexts(next).includes("BEFORE_RELOAD @context.txt"));
    assert.ok(contextTexts(next).includes('<file path="context.txt">\nAFTER_RELOAD_CONTEXT\n</file>'));
    assert.deepEqual(h.resourceLoader.getExtensions().errors, []);
  });
});

describe("Extension and tool consumers", () => {
  const files = { "note.md": "CONSUMER_CONTENT", "secret.md": "MUST_NOT_ATTACH", "large.md": "x".repeat(100_001) };

  test("extension command explicitly propagates extension-policy context and failures to its model call without resolver UI", async (t) => {
    const h = await createHarness(t, { files, extensions: [consumerExtension], projectSettings: JSON.stringify({ sources: {
      userInput: { files: false, commands: false }, extension: { commands: true, display: "always" },
    } }) });
    h.queue();
    await h.session.prompt('/consumer @note.md @missing.md @large.md !`printf x >> consumer-count; printf COMMAND_OUTPUT` !`exit 8`');
    assert.equal(h.requests.length, 1);
    const texts = contextTexts(h.requests[0]!);
    assert.ok(texts.includes('<file path="note.md">\nCONSUMER_CONTENT\n</file>'));
    assert.ok(texts.some((text) => text.startsWith("<bash ") && text.includes("\nCOMMAND_OUTPUT\n")));
    const references = JSON.parse(texts.at(-1)!);
    assert.deepEqual(references.map((reference: { status: string }) => reference.status), ["success", "missing", "oversized", "success", "error"]);
    assert.equal(await readFile(join(h.cwd, "consumer-count"), "utf8"), "x");
    assert.deepEqual(h.session.messages.map((message) => message.role === "custom" ? message.customType : message.role), ["consumer-result"]);
  });

  for (const scenario of [
    { mode: "files", settings: { commands: true, files: true }, statuses: ["success", "disabled"] },
    { mode: "files", settings: { commands: true, files: false }, statuses: ["disabled", "disabled"] },
    { mode: "all", settings: { commands: false, files: false }, statuses: ["disabled", "disabled"] },
    { mode: "all", settings: { commands: true, files: true }, statuses: ["success", "success"] },
  ] as const) {
    test(`fixture tool propagates ${scenario.mode} outcomes with extension policy ${JSON.stringify(scenario.settings)}`, async (t) => {
      const h = await createHarness(t, { files, extensions: [consumerExtension], projectSettings: JSON.stringify({ sources: {
        userInput: { files: false, commands: false }, extension: { ...scenario.settings, display: "always" },
      } }) });
      h.queue(fauxAssistantMessage(fauxToolCall("resolve_fixture", {
        text: '@note.md !`printf x >> tool-count; printf TOOL_OUTPUT`', mode: scenario.mode,
      }), { stopReason: "toolUse" }));
      const request = await h.prompt("Use the fixture tool");
      const toolResult = request.messages.find((message) => message.role === "toolResult");
      assert.ok(toolResult?.role === "toolResult");
      const block = toolResult.content[0];
      assert.ok(block?.type === "text");
      const result = JSON.parse(block.text);
      assert.deepEqual(result.references.map((reference: { status: string }) => reference.status), scenario.statuses);
      assert.equal(result.context.length, scenario.statuses.filter((status) => status === "success").length);
      assert.equal(h.requests.length, 2);
      assert.equal(h.session.messages.filter((message) => message.role === "custom").length, 0);
      if (scenario.mode === "all" && scenario.settings.commands) {
        assert.equal(await readFile(join(h.cwd, "tool-count"), "utf8"), "x");
        assert.ok(result.context.includes('<file path="note.md">\nCONSUMER_CONTENT\n</file>'));
      } else await assert.rejects(readFile(join(h.cwd, "tool-count")), { code: "ENOENT" });
      const savedResult = h.session.messages.find((message) => message.role === "toolResult");
      assert.ok(savedResult?.role === "toolResult");
      assert.deepEqual(savedResult.details, result);
    });
  }

  test("arbitrary tool output stays inert with all resolver capabilities enabled", async (t) => {
    const h = await createHarness(t, { files, extensions: [consumerExtension] });
    h.queue(fauxAssistantMessage(fauxToolCall("raw_fixture", {}), { stopReason: "toolUse" }));
    const request = await h.prompt("Use the raw fixture tool");
    assert.ok(contextTexts(request).includes('@secret.md !`touch forbidden`'));
    assert.doesNotMatch(contextTexts(request).join("\n"), /MUST_NOT_ATTACH|<file path=|<bash command=/);
    await assert.rejects(readFile(join(h.cwd, "forbidden")), { code: "ENOENT" });
    assert.equal(h.session.messages.filter((message) => message.role === "custom").length, 0);
  });
});
