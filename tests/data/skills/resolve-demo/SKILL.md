---
name: resolve-demo
description: Fixture skill for pi-resolve tests. Exercises @file and !`command` resolution inside a skill body.
---

# Resolve Demo

This skill exists only to verify that pi-resolve expands references inside an
expanded skill body. When invoked via `/skill:resolve-demo`, pi-resolve should:

1. Attach the contents of the file below as a `<file>` context message.
2. Run the command below and attach its stdout as a `<bash>` context message.

File reference (resolved relative to this skill's directory):

@fixture.md

Command reference (runs in the project cwd):

!`echo HELLO_FROM_SKILL_CMD`

Argument echo (substituted before resolution): $ARGUMENTS
