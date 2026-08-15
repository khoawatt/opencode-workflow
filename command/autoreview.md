---
description: Bật/tắt ChatGPT auto-review (on, off, status)
agent: build
---

Run the auto-review toggle:

`~/.config/opencode/chatgpt-bridge/bin/autoreview $ARGUMENTS`

Where `$ARGUMENTS` is `on`, `off`, or `status`.

Report the result to the user. If toggled on, tell the user auto-review is now
active: after each implementation task with code changes, you will write your
normal result summary and invoke `@chatgpt-review`, which wraps it in workflow
context and returns a machine-actionable verdict. On `approve` the workflow
advances and stops (no redundant re-review); on `request-changes` you fix and
re-review. If toggled off, tell the user reviews are manual-only (`@chatgpt-review`).
