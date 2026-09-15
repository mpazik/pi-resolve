import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("../scripts/release.ts", import.meta.url));
const history = "## 0.1.0 (2026-09-15)\n\n- Initial release.\n";
const pending = `# Changelog\n\n## Unreleased\n\n- Fix reference handling.\n\n### Compatibility\n\n- Keep Pi peers unchanged.\n\n${history}`;

function assertRelease(
  input: { command: string; changelog?: string; lockVersion?: string },
  expected: { version: string } | { error: RegExp },
): void {
  const cwd = mkdtempSync(join(tmpdir(), "pi-resolve-release-"));
  try {
    const files = {
      "package.json": JSON.stringify({ name: "pi-resolve", version: "0.1.9", dependencies: {} }, null, 2) + "\n",
      "package-lock.json": JSON.stringify({ name: "pi-resolve", version: input.lockVersion ?? "0.1.9", lockfileVersion: 3, packages: { "": { name: "pi-resolve", version: "0.1.9" } } }, null, 2) + "\n",
      "CHANGELOG.md": input.changelog ?? pending,
    };
    for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content);
    const beforeDate = new Date().toISOString().slice(0, 10);
    const result = spawnSync(process.execPath, [script, input.command], { cwd, encoding: "utf8" });
    if ("error" in expected) {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected.error);
      assert.deepEqual(Object.fromEntries(Object.keys(files).map((name) => [name, readFileSync(join(cwd, name), "utf8")])), files);
      return;
    }
    assert.equal(result.status, 0, result.stderr);
    const afterDate = new Date().toISOString().slice(0, 10);
    const changelog = readFileSync(join(cwd, "CHANGELOG.md"), "utf8");
    const date = changelog.match(/^## \d+\.\d+\.\d+ \((\d{4}-\d{2}-\d{2})\)$/m)?.[1];
    assert(date === beforeDate || date === afterDate);
    const notes = spawnSync(process.execPath, [script, "notes", expected.version], { cwd, encoding: "utf8" });
    assert.deepEqual({
      output: result.stdout,
      pkg: JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")),
      lock: JSON.parse(readFileSync(join(cwd, "package-lock.json"), "utf8")),
      changelog,
      notes: { status: notes.status, stdout: notes.stdout, stderr: notes.stderr },
    }, {
      output: `version=${expected.version}\ntag=v${expected.version}\n`,
      pkg: { name: "pi-resolve", version: expected.version, dependencies: {} },
      lock: { name: "pi-resolve", version: expected.version, lockfileVersion: 3, packages: { "": { name: "pi-resolve", version: expected.version } } },
      changelog: `# Changelog\n\n## Unreleased\n\n## ${expected.version} (${date})\n\n- Fix reference handling.\n\n### Compatibility\n\n- Keep Pi peers unchanged.\n\n${history}`,
      notes: { status: 0, stdout: "- Fix reference handling.\n\n### Compatibility\n\n- Keep Pi peers unchanged.\n", stderr: "" },
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("patch finalizes only the pending notes and synchronizes package versions", () => {
  assertRelease({ command: "patch" }, { version: "0.1.10" });
});

test("minor resets the patch number and preserves earlier release notes", () => {
  assertRelease({ command: "minor" }, { version: "0.2.0" });
});

test("missing pending section refuses release without changing files", () => {
  assertRelease({ command: "patch", changelog: `# Changelog\n\n${history}` }, { error: /Missing changelog section/ });
});

test("empty pending notes refuse release without changing files", () => {
  assertRelease({ command: "patch", changelog: `# Changelog\n\n## Unreleased\n\n<!-- Add notes here -->\n\n${history}` }, { error: /No release notes/ });
});

test("unsupported bump refuses release without changing files", () => {
  assertRelease({ command: "major" }, { error: /Usage:/ });
});

test("mismatched lockfile refuses release without changing files", () => {
  assertRelease({ command: "minor", lockVersion: "0.1.8" }, { error: /Lockfile version mismatch/ });
});
