import assert from "node:assert/strict";
import { test } from "node:test";
import { cfgFor, mergeSettings, shouldDisplay, validateSettings, type Source } from "../extensions/settings.ts";

const sources: Source[] = ["userInput", "systemPrompt", "skill", "extension"];

test("built-in defaults and every independent source bucket", () => {
  for (const source of sources) {
    assert.deepEqual(cfgFor(mergeSettings({}, {}), source), { files: true, commands: true, display: "always" });
    const settings = mergeSettings(validateSettings({ sources: { [source]: { files: false, commands: false, display: "never" } } }).settings, {});
    for (const candidate of sources) {
      assert.deepEqual(cfgFor(settings, candidate), candidate === source
        ? { files: false, commands: false, display: "never" }
        : { files: true, commands: true, display: "always" });
    }
  }
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

test("display filtering covers successes, errors and skipped results", () => {
  for (const [display, expected] of [["always", [true, true, true]], ["errors", [false, true, true]], ["never", [false, false, false]]] as const) {
    assert.deepEqual(["ok", "error", "skipped"].map((status) => shouldDisplay(display, status as "ok" | "error" | "skipped")), expected);
  }
});
