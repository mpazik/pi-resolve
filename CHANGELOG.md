# Changelog

## Unreleased

## 0.1.1 (2026-11-02)

- Add manual patch/minor releases with changelog-driven release notes and npm
  publishing after CI and packed-package checks.
- Show the attached file contents and command output under their status rows
  when tool output is expanded (Ctrl+O by default).

## 0.1.0 (2026-09-15)

- Initial release of `pi-resolve`.
- Resolve `@file` and `` !`command` `` references in user input, system
  prompts, skills, and prompt templates before the agent responds.
- Support single-level file imports, immediate directory listings, `~/`
  expansion, and escaping for literal references.
- Configure file and command permissions, UI feedback, byte limits, and command
  timeouts through global and project settings. Commands default off for
  templates, skills, and shared extension calls.
- Show reference status in Pi's UI and report failed or omitted imports to the
  model.
- Let other extensions opt into resolution through the `pi-resolve:resolve`
  shared event, with structured results and a file-only mode.
