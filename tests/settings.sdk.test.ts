import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import consumerExtension from "./data/consumer-extension.ts";
import { createHarness, contextTexts } from "./session-harness.ts";
import { createResolverHarness } from "./resolver-harness.ts";



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
