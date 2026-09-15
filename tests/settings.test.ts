import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cfgFor, mergeSettings, shouldDisplay, validateSettings, type Source } from "../src/settings.ts";
const sources: Source[] = ["userInput", "template", "systemPrompt", "skill", "extension"];

describe("Defaults and precedence", () => {
  test("built-in policy trusts user and system commands and displays only user prompts", () => {
    const settings = mergeSettings({}, {});
    assert.deepEqual(sources.map((source) => cfgFor(settings, source)), [
      { files: true, commands: true, display: "always" },
      { files: true, commands: false, display: "always" },
      { files: true, commands: true, display: "never" },
      { files: true, commands: false, display: "never" },
      { files: true, commands: false, display: "never" },
    ]);
  });

  test("explicit defaults disable all sources including built-in source defaults", () => {
    const settings = mergeSettings(validateSettings({ defaults: { files: false, commands: false, display: "never" } }).settings, {});
    assert.deepEqual(sources.map((source) => cfgFor(settings, source)), Array(5).fill({ files: false, commands: false, display: "never" }));
  });

  test("global display always overrides every built-in source display restriction", () => {
    const settings = mergeSettings(validateSettings({ defaults: { display: "always" } }).settings, {});
    assert.deepEqual(sources.map((source) => cfgFor(settings, source).display), ["always", "always", "always", "always", "always"]);
  });

  test("project defaults can relax built-in restrictions and display all sources", () => {
    const settings = mergeSettings(validateSettings({ defaults: { commands: false, display: "never" } }).settings,
      validateSettings({ defaults: { commands: true, display: "always" } }).settings);
    assert.deepEqual(sources.map((source) => cfgFor(settings, source)), Array(5).fill({ files: true, commands: true, display: "always" }));
  });

  test("project source overrides can relax explicit global restrictions per field", () => {
    const settings = mergeSettings(validateSettings({ sources: { template: { commands: false, files: false, display: "never" } } }).settings,
      validateSettings({ sources: { template: { commands: true } } }).settings);
    assert.deepEqual(cfgFor(settings, "template"), { commands: true, files: false, display: "never" });
  });

  test("per-field inheritance keeps source restrictions more specific than project defaults", () => {
    const global = validateSettings({ defaults: { commands: false, display: "errors" }, sources: {
      skill: { commands: false, files: false }, userInput: { commands: false }, extension: { files: false },
    } }).settings;
    const project = validateSettings({ defaults: { commands: true, files: false }, sources: {
      skill: { display: "never" }, extension: { files: true },
    } }).settings;
    const merged = mergeSettings(global, project);
    assert.deepEqual(cfgFor(merged, "skill"), { files: false, commands: false, display: "never" });
    assert.deepEqual(cfgFor(merged, "systemPrompt"), { files: false, commands: true, display: "errors" });
    assert.deepEqual(cfgFor(merged, "userInput"), { files: false, commands: false, display: "errors" });
    assert.deepEqual(cfgFor(merged, "extension"), { files: true, commands: true, display: "errors" });
  });
});

describe("Byte limits", () => {
  test("byte limits inherit per field and accept positive safe integers", () => {
    const global = validateSettings({ limits: { maxFileBytes: 3, maxCommandBytes: 5 } });
    const project = validateSettings({ limits: { maxFileBytes: 7, maxTotalBytes: Number.MAX_SAFE_INTEGER } });
    assert.deepEqual(global.issues, []);
    assert.deepEqual(project.issues, []);
    assert.deepEqual(mergeSettings(global.settings, project.settings).limits, {
      maxFileBytes: 7, maxCommandBytes: 5, maxTotalBytes: Number.MAX_SAFE_INTEGER, commandTimeoutMs: 10_000,
    });
    assert.deepEqual(mergeSettings({}, {}).limits, {
      maxFileBytes: 100_000, maxCommandBytes: 100_000, maxTotalBytes: 1_000_000, commandTimeoutMs: 10_000,
    });
  });
});

describe("Command timeout", () => {
  test("project timeout overrides global without replacing inherited byte limits", () => {
    const global = validateSettings({ limits: { commandTimeoutMs: 30_000, maxFileBytes: 50 } });
    const project = validateSettings({ limits: { commandTimeoutMs: 60_000 } });
    assert.deepEqual({ globalIssues: global.issues, projectIssues: project.issues,
      limits: mergeSettings(global.settings, project.settings).limits }, {
      globalIssues: [], projectIssues: [],
      limits: { maxFileBytes: 50, maxCommandBytes: 100_000, maxTotalBytes: 1_000_000, commandTimeoutMs: 60_000 },
    });
  });

  test("omitting a project timeout preserves the global deadline", () => {
    const global = validateSettings({ limits: { commandTimeoutMs: 30_000 } }).settings;
    const project = validateSettings({ limits: { maxFileBytes: 50 } }).settings;
    assert.deepEqual(mergeSettings(global, project).limits, {
      maxFileBytes: 50, maxCommandBytes: 100_000, maxTotalBytes: 1_000_000, commandTimeoutMs: 30_000,
    });
  });

  test("one millisecond is a valid deadline", () => {
    assert.deepEqual(validateSettings({ limits: { commandTimeoutMs: 1 } }), {
      settings: { limits: { commandTimeoutMs: 1 } }, issues: [],
    });
  });

  test("Node's maximum timer duration is accepted without clamping", () => {
    assert.deepEqual(validateSettings({ limits: { commandTimeoutMs: 2_147_483_647 } }), {
      settings: { limits: { commandTimeoutMs: 2_147_483_647 } }, issues: [],
    });
  });

  test("timer overflow is rejected instead of becoming a one-millisecond deadline", () => {
    assert.deepEqual(validateSettings({ limits: { commandTimeoutMs: 2_147_483_648 } }), {
      settings: { limits: {} }, issues: [{ path: "limits.commandTimeoutMs", code: "invalid-value" }],
    });
  });

  test("zero cannot disable the command deadline", () => {
    assert.deepEqual(validateSettings({ limits: { commandTimeoutMs: 0 } }), {
      settings: { limits: {} }, issues: [{ path: "limits.commandTimeoutMs", code: "invalid-value" }],
    });
  });

  test("negative durations are rejected", () => {
    assert.deepEqual(validateSettings({ limits: { commandTimeoutMs: -1 } }), {
      settings: { limits: {} }, issues: [{ path: "limits.commandTimeoutMs", code: "invalid-value" }],
    });
  });

  test("fractional milliseconds are rejected", () => {
    assert.deepEqual(validateSettings({ limits: { commandTimeoutMs: 1.5 } }), {
      settings: { limits: {} }, issues: [{ path: "limits.commandTimeoutMs", code: "invalid-value" }],
    });
  });

  test("invalid project values preserve the global timeout without exposing the value", () => {
    const global = validateSettings({ limits: { commandTimeoutMs: 30_000 } }).settings;
    const project = validateSettings({ limits: { commandTimeoutMs: "PRIVATE", maxFileBytes: 50 } });
    assert.deepEqual(project, {
      settings: { limits: { maxFileBytes: 50 } },
      issues: [{ path: "limits.commandTimeoutMs", code: "invalid-value" }],
    });
    assert.deepEqual(mergeSettings(global, project.settings).limits, {
      maxFileBytes: 50, maxCommandBytes: 100_000, maxTotalBytes: 1_000_000, commandTimeoutMs: 30_000,
    });
  });
});

describe("Validation and diagnostics", () => {
  test("invalid byte limits retain valid siblings and do not expose input values", () => {
    const invalid = validateSettings({ limits: { maxFileBytes: 0, maxCommandBytes: 1.5, maxTotalBytes: Number.MAX_SAFE_INTEGER + 1, PRIVATE: "SECRET" } });
    assert.deepEqual(invalid, { settings: { limits: {} }, issues: [
      { path: "limits.maxFileBytes", code: "invalid-value" },
      { path: "limits.maxCommandBytes", code: "invalid-value" },
      { path: "limits.maxTotalBytes", code: "invalid-value" },
      { path: "limits", code: "unknown-key" },
    ] });
    assert.deepEqual(validateSettings({ limits: { maxFileBytes: "SECRET", maxCommandBytes: -1, maxTotalBytes: 9 } }).settings, { limits: { maxTotalBytes: 9 } });
    assert.deepEqual(validateSettings({ limits: null }).issues, [{ path: "limits", code: "invalid-object" }]);
  });

  test("invalid shapes, types, enums and unknown keys cannot replace inherited values or leak values", () => {
    for (const value of [null, [], true, "PRIVATE", 123]) {
      assert.deepEqual(validateSettings(value), { settings: {}, issues: [{ path: "$", code: "invalid-object" }] });
    }
    for (const value of [null, [], "PRIVATE", false, 3]) {
      for (const key of ["defaults", "sources"]) {
        const result = validateSettings({ [key]: value });
        assert.deepEqual(result.issues, [{ path: key, code: "invalid-object" }]);
      }
      for (const source of sources) {
        assert.deepEqual(validateSettings({ sources: { [source]: value } }).issues,
          [{ path: `sources.${source}`, code: "invalid-object" }]);
      }
    }
    for (const source of sources) {
      const result = validateSettings({ PRIVATE_KEY: "PRIVATE_VALUE", defaults: { files: "PRIVATE_VALUE", commands: 0, display: "sometimes" }, sources: {
        PRIVATE_SOURCE: {}, [source]: { files: null, commands: [], display: false, PRIVATE_KEY: "PRIVATE_VALUE" },
      } });
      assert.equal(result.issues.length, 9);
      assert.doesNotMatch(JSON.stringify(result.issues), /PRIVATE|sometimes/);
      const inherited = validateSettings({ defaults: { files: false, commands: false, display: "errors" } }).settings;
      assert.deepEqual(cfgFor(mergeSettings(inherited, result.settings), source), { files: false, commands: false, display: "errors" });
    }
  });

  test("valid sibling settings survive validation failures without mutating inputs", () => {
    const globalInput = { defaults: { files: false, commands: false, display: "errors" } };
    const projectInput = { defaults: { files: true, commands: "invalid" }, sources: {
      skill: { display: "never", files: null }, extension: { commands: true },
    } };
    const before = structuredClone({ globalInput, projectInput });
    const global = validateSettings(globalInput).settings;
    const project = validateSettings(projectInput).settings;
    const validated = structuredClone({ global, project });
    const settings = mergeSettings(global, project);
    assert.deepEqual(cfgFor(settings, "skill"), { files: true, commands: false, display: "never" });
    assert.deepEqual(cfgFor(settings, "extension"), { files: true, commands: true, display: "errors" });
    assert.deepEqual({ globalInput, projectInput }, before);
    assert.deepEqual({ global, project }, validated);
  });
});

describe("Display filtering", () => {
  test("display filtering covers successes, errors and skipped results", () => {
    for (const [display, expected] of [["always", [true, true, true]], ["errors", [false, true, true]], ["never", [false, false, false]]] as const) {
      assert.deepEqual(["ok", "error", "skipped"].map((status) => shouldDisplay(display, status as "ok" | "error" | "skipped")), expected);
    }
  });
});
