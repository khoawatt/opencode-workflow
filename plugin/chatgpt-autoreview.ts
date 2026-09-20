import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { Plugin } from "@opencode/plugin"

const STATE_FILE = join(homedir(), ".config/opencode/chatgpt-bridge/autoreview.json")
const BRIDGE = join(homedir(), ".config/opencode/chatgpt-bridge/bin/chatgpt-review")

function isAutoReviewEnabled(): boolean {
  try {
    if (!existsSync(STATE_FILE)) return false
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8"))
    return state.enabled === true
  } catch {
    return false
  }
}

const AUTO_REVIEW_INSTRUCTION = `## ChatGPT Auto-Review (workflow-aware)

Auto-review is ENABLED. When you are the primary Build agent implementing a task
and you have made code changes, before presenting your final result:

1. Write your normal result summary (the "Done / What changed / Verification" text).
2. Invoke the \`chatgpt-review\` subagent via the Task tool, passing your result
   summary text verbatim. Do NOT attach a git diff — the subagent wraps it in
   workflow context (mode/goal/stage/requested-decision/authority).
3. Consume the verdict it returns:
   - \`approve\` → advance to the next permitted workflow state and STOP. Do NOT
     invoke another review just to confirm the same approval. Report:
     "ChatGPT approved; status: awaiting human merge" (or the appropriate next step).
   - \`approve-with-changes\` → apply the non-blocking cleanup if reasonable; do
     not re-review unless the reviewed state changed.
   - \`request-changes\` → report the issues, fix them, rerun verification, push,
     then invoke \`chatgpt-review\` again (state changed → re-review is correct).
   - \`reject\` → stop and report that replanning is required.

Do NOT trigger auto-review if you are the \`chatgpt-review\` subagent itself, the
\`vision\` subagent, or a read-only analysis agent — only the primary Build agent.
Do NOT auto-review a task that is purely conversational (no code or files changed).
Never treat ChatGPT's "approve" as permission to merge — merge is human-only.`

async function server() {
  return {
    "shell.env": async (_input: unknown, output: { env: Record<string, string> }) => {
      output.env.CHATGPT_AUTO_REVIEW = isAutoReviewEnabled() ? "1" : "0"
      output.env.CHATGPT_REVIEW_BRIDGE = BRIDGE
    },
    "experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => {
      if (isAutoReviewEnabled()) {
        output.system.push(AUTO_REVIEW_INSTRUCTION)
      }
    },
  }
}

// Kept identifier for backwards compat (tests + old V1 loader).
export const ChatGPTAutoReview = server

export default {
  ...Plugin.define({
    id: "chatgpt-autoreview",
    async setup(ctx: {
      shell: { hook: (name: "create.before", fn: (event: { env: Record<string, string> }) => void) => Promise<unknown> }
      session: { hook: (name: "context", fn: (event: { system: { type: string; text: string }[] }) => void) => Promise<unknown> }
    }) {
      await ctx.shell.hook("create.before", (event) => {
        event.env.CHATGPT_AUTO_REVIEW = isAutoReviewEnabled() ? "1" : "0"
        event.env.CHATGPT_REVIEW_BRIDGE = BRIDGE
      })

      await ctx.session.hook("context", (event) => {
        if (isAutoReviewEnabled()) {
          event.system.push({ type: "text", text: AUTO_REVIEW_INSTRUCTION })
        }
      })
    },
  }),
  async server() {
    return server()
  },
}
