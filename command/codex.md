---
description: Nhờ Codex CLI làm 1 task headless trong subtask riêng
agent: build
subtask: true
---

Nhờ `codex` (OpenAI Codex CLI, non-interactive `exec` mode) thực hiện task sau
cho repo hiện tại. Chạy trong subtask này, KHÔNG làm bẩn context chính.
`$ARGUMENTS` là task.

1. Soạn prompt self-contained gồm:
   - Goal: mục tiêu 1-2 câu.
   - Scope: file/dir được phép đụng tới; cấm sửa ngoài scope.
   - Done criteria: điều kiện hoàn tất + verification cần chạy.
   - Constraints: tuân thủ AGENTS.md; không commit/push/merge/rebase/reset/clean/
     restore/checkout; không thay đổi workflow approval state; để working tree cho
     OpenCode kiểm tra.

2. Chọn sandbox tối thiểu:
   - Review/analysis/planning, không cần sửa file: `--sandbox read-only`.
   - Implementation/fix cần sửa file: `--sandbox workspace-write`.
   - Luôn thêm `-c 'approvals_reviewer="user"'` để một config
     `approvals_reviewer=auto_review` của user/project không âm thầm nâng quyền
     vượt sandbox đã chọn.
   - KHÔNG dùng `--full-auto`, `--dangerously-bypass-approvals-and-sandbox`,
     `--yolo`, `--approve-for-me`, `--not-so-yolo`, `danger-full-access`,
     `--add-dir` hay `--worktree`.

3. Chạy Codex bằng JSONL để lấy exact thread id. Với implementation:

   ```bash
   codex exec --json --sandbox workspace-write -c 'approvals_reviewer="user"' - <<'CODEX_TASK_EOF'
   <prompt self-contained>
   CODEX_TASK_EOF
   ```

   Với read-only task, thay `workspace-write` bằng `read-only`.
   Parse stream:
   - `thread.started.thread_id` = session id để follow-up.
   - final `item.completed` có `item.type="agent_message"` = response.
   - chỉ coi run thành công khi process exit 0 và có `turn.completed`.
   - `turn.failed` hoặc top-level `type="error"` = failure.
   - `item.type="error"` có thể chỉ là warning nếu sau đó vẫn có
     `turn.completed` + exit 0; không fail chỉ vì item-level warning.

4. Tự verify read-only bằng `git status --short` + `git diff --stat` và xác nhận
   chỉ file trong scope thay đổi. Nếu incomplete hoặc Codex đụng ngoài scope,
   follow-up tối đa 2 vòng trên CHÍNH thread đó:

   ```bash
   codex exec --json --sandbox workspace-write -c 'approvals_reviewer="user"' resume <thread_id> - <<'CODEX_FOLLOWUP_EOF'
   <follow-up cụ thể; yêu cầu tự sửa/revert phần Codex vừa làm sai nếu cần>
   CODEX_FOLLOWUP_EOF
   ```

   Không tự dùng git restore/reset để dọn thay Codex.

5. Trả lời user ngắn gọn:
   - Codex đã làm gì (final agent message, tóm tắt nếu dài).
   - Files changed từ `git diff --stat`.
   - Verification Codex đã chạy + kiểm tra read-only của bạn.
   - Remaining risks/blocked actions nếu có.
   - `thread_id` để follow-up tiếp.
