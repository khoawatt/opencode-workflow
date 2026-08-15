---
description: Quản lý ChatGPT Project cho repo hiện tại (status/create/attach/detach)
agent: build
---

Manage the ChatGPT Project for the current repo+branch via the bridge:

- `~/.config/opencode/chatgpt-bridge/bin/chatgpt-review project list` — liệt kê mọi project
- `~/.config/opencode/chatgpt-bridge/bin/chatgpt-review project resolve` — project đang dùng cho repo này
- `~/.config/opencode/chatgpt-bridge/bin/chatgpt-review project attach <name>` — map repo này vào project có sẵn
- `~/.config/opencode/chatgpt-bridge/bin/chatgpt-review project detach` — bỏ mapping project cho repo này
- `~/.config/opencode/chatgpt-bridge/bin/chatgpt-review project create <name>` — tạo project mới

Run the appropriate command based on $ARGUMENTS (e.g. `attach qvak-portfolio` or `status`),
then summarize the result for the user in 1-2 lines.
