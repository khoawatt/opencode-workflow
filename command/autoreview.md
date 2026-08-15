---
description: Bật/tắt ChatGPT auto-review (on, off, status)
agent: build
---

Run the auto-review toggle:

`~/.config/opencode/chatgpt-bridge/bin/autoreview $ARGUMENTS`

Where `$ARGUMENTS` is `on`, `off`, or `status`.

Report the result to the user. If toggled on, tell the user auto-review is now
active: after each implementation task with code changes, you will automatically
invoke `@chatgpt-review` to send the diff to ChatGPT Plus and report the verdict.
If toggled off, tell the user reviews are now manual-only (`@chatgpt-review`).
