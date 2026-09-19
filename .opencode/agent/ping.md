---
description: >-
  Internal probe agent. The subagent_dispatch plugin uses it to verify a
  model endpoint is usable before a real dispatch. Not a roster worker;
  never dispatch it for real tasks.
mode: subagent
hidden: true
temperature: 0
permission:
  edit: deny
  bash: deny
  task: deny
  subagent_dispatch: deny
---

Reply with exactly: OK. Use no tools, add nothing else.
