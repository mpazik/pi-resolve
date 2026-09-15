import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const [command, versionArgument] = process.argv.slice(2);
const changelog = readFileSync("CHANGELOG.md", "utf8");

function section(heading: string): { start: number; end: number; notes: string } {
  const headings = [...changelog.matchAll(/^## (.+)$/gm)];
  const index = headings.findIndex((match) => match[1] === heading);
  assert(index >= 0, `Missing changelog section: ## ${heading}`);
  assert.equal(headings.filter((match) => match[1] === heading).length, 1, "Duplicate changelog section");
  const match = headings[index];
  const start = match.index;
  const end = headings[index + 1]?.index ?? changelog.length;
  const notes = changelog.slice(start + match[0].length, end).trim();
  assert(notes.replace(/<!--[\s\S]*?-->/g, "").trim(), `No release notes in ## ${heading}`);
  return { start, end, notes };
}

if (command === "notes") {
  assert(versionArgument && /^\d+\.\d+\.\d+$/.test(versionArgument), "Expected a release version");
  const heading = [...changelog.matchAll(/^## (.+)$/gm)]
    .map((match) => match[1])
    .find((value) => value.startsWith(`${versionArgument} (`));
  assert(heading, `Missing release notes for ${versionArgument}`);
  console.log(section(heading).notes);
} else {
  assert((command === "patch" || command === "minor") && !versionArgument, "Usage: release.ts patch|minor OR release.ts notes <version>");
  const pending = section("Unreleased");
  assert.equal(changelog.slice(0, pending.start).match(/^## /gm), null, "Unreleased must be the first changelog section");
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  assert.equal(lock.version, pkg.version, "Lockfile version mismatch");
  assert.equal(lock.packages[""].version, pkg.version, "Lockfile root version mismatch");
  assert(/^\d+\.\d+\.\d+$/.test(pkg.version), "Expected a stable package version");
  const [major, minor, patch] = pkg.version.split(".").map(Number);
  const numbers = command === "minor" ? [major, minor + 1, 0] : [major, minor, patch + 1];
  assert(numbers.every(Number.isSafeInteger), "Version exceeds safe integer range");
  const version = numbers.join(".");
  assert(!new RegExp(`^## ${version.replaceAll(".", "\\.")}(?: |$)`, "m").test(changelog), "Release already exists in changelog");
  const date = new Date().toISOString().slice(0, 10);
  const updatedChangelog = `${changelog.slice(0, pending.start)}## Unreleased\n\n## ${version} (${date})\n\n${pending.notes}\n\n${changelog.slice(pending.end)}`;
  pkg.version = version;
  lock.version = version;
  lock.packages[""].version = version;
  writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync("package-lock.json", `${JSON.stringify(lock, null, 2)}\n`);
  writeFileSync("CHANGELOG.md", updatedChangelog);
  console.log(`version=${version}\ntag=v${version}`);
}
