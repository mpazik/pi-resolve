# Changelog

## 0.1.0 (unreleased)

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
