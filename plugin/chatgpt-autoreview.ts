import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import type { Plugin } from "@opencode-ai/plugin"

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

const AUTO_REVIEW_INSTRUCTION = `## ChatGPT Auto-Review

Auto-review is ENABLED. When you are the primary Build agent implementing a task
and you have made code changes, before presenting your final result:

1. Summarize the diff (or use \`git diff\` if it is a git repo).
2. Invoke the \`chatgpt-review\` subagent via the Task tool with a prompt like:
   "Review the current changes with ChatGPT: <one-line summary of what changed and what to focus on>".
3. Report ChatGPT's verdict in your final message and fix any actionable issues you agree with.

Do NOT trigger auto-review if you are the \`chatgpt-review\` subagent itself, the
\`vision\` subagent, or a read-only analysis agent — only the primary Build agent.
Do NOT auto-review a task that is purely conversational (no code or files changed).`

export const ChatGPTAutoReview: Plugin = async () => {
  return {
    "shell.env": async (input, output) => {
      output.env.CHATGPT_AUTO_REVIEW = isAutoReviewEnabled() ? "1" : "0"
      output.env.CHATGPT_REVIEW_BRIDGE = BRIDGE
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (isAutoReviewEnabled()) {
        output.system.push(AUTO_REVIEW_INSTRUCTION)
      }
    },
  }
}
