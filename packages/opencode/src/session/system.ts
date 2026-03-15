import { Ripgrep } from "../file/ripgrep"

import { Instance } from "../project/instance"
import { Memory } from "../memory/memory"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_ANTHROPIC_WITHOUT_TODO from "./prompt/qwen.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"

import PROMPT_CODEX from "./prompt/codex_header.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { PermissionNext } from "@/permission/next"
import { Skill } from "@/skill"

export namespace SystemPrompt {
  export function instructions() {
    return PROMPT_CODEX.trim()
  }

  export function provider(model: Provider.Model) {
    if (model.api.id.includes("gpt-5")) return [PROMPT_CODEX]
    if (model.api.id.includes("gpt-") || model.api.id.includes("o1") || model.api.id.includes("o3"))
      return [PROMPT_BEAST]
    if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
    if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
    if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
    return [PROMPT_ANTHROPIC_WITHOUT_TODO]
  }

  export async function environment(model: Provider.Model) {
    const project = Instance.project
    return [
      [
        `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        `  Working directory: ${Instance.directory}`,
        `  Workspace root folder: ${Instance.worktree}`,
        `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
        `  Platform: ${process.platform}`,
        `  Today's date: ${new Date().toDateString()}`,
        `</env>`,
        `<directories>`,
        `  ${
          project.vcs === "git" && false
            ? await Ripgrep.tree({
                cwd: Instance.directory,
                limit: 50,
              })
            : ""
        }`,
        `</directories>`,
      ].join("\n"),
    ]
  }

  export async function skills(agent: Agent.Info) {
    if (PermissionNext.disabled(["skill"], agent.permission).has("skill")) return

    const list = await Skill.available(agent)

    return [
      "Skills provide specialized instructions and workflows for specific tasks.",
      "Use the skill tool to load a skill when a task matches its description.",
      // the agents seem to ingest the information about skills a bit better if we present a more verbose
      // version of them here and a less verbose version in tool description, rather than vice versa.
      Skill.fmt(list, { verbose: true }),
    ].join("\n")
  }

  export function memory() {
    return [
      "## Memory Usage Guidelines",
      "",
      "You have access to persistent project memory tools that survive across sessions:",
      "",
      "**Memory Tools:**",
      "- memory_write: Save important information (key-value pairs) for future sessions",
      "- memory_read: Retrieve previously saved information by key",
      "- memory_search: Find relevant memories by key pattern (e.g., 'arch.*') or tags",
      "- memory_list: List all stored memory keys and their tags",
      "- context_log: Log decisions, changes, notes for project tracking",
      "",
      "**PROACTIVE USAGE - Save to memory when:**",
      "- You discover architectural patterns or code structures",
      "- You make important implementation decisions",
      "- You find file relationships or project conventions",
      "- You learn user preferences or project-specific patterns",
      "- You complete significant work that should be remembered",
      "",
      "**PROACTIVE USAGE - Search memory when:**",
      "- Starting a new task - search for related previous work",
      "- User asks about something from previous sessions",
      "- Working on files you've seen before",
      "- User mentions something you've worked on",
      "",
      "**Key Naming Convention:**",
      "Use dot notation: 'arch.x', 'pattern.x', 'pref.x', 'task.x'",
      "Example: 'arch.storage', 'pattern.naming', 'pref.style', 'task.current'",
      "",
      "Memory persists across sessions and survives context compaction.",
    ].join("\n")
  }

  let recentMemoryCache: { timestamp: number; content: string } | null = null
  const RECENT_MEMORY_CACHE_TTL = 60 * 1000 // 1 minute cache

  export async function recentMemory() {
    const now = Date.now()
    if (recentMemoryCache && now - recentMemoryCache.timestamp < RECENT_MEMORY_CACHE_TTL) {
      return recentMemoryCache.content
    }

    const memories = Memory.list()
    if (memories.length === 0) {
      recentMemoryCache = { timestamp: now, content: "" }
      return
    }

    const recent = memories.slice(0, 5)
    const lines = ["## Recent Project Memories", ""]

    for (const mem of recent) {
      try {
        const full = Memory.get(mem.key)
        if (full) {
          const preview =
            typeof full.value === "string" ? full.value.slice(0, 200) : JSON.stringify(full.value).slice(0, 200)
          lines.push(`- **${mem.key}** [${mem.tags.join(", ")}]: ${preview}...`)
        }
      } catch {
        // Skip if memory read fails
      }
    }

    const content = lines.join("\n")
    recentMemoryCache = { timestamp: now, content }
    return content
  }

  export function clearRecentMemoryCache(): void {
    recentMemoryCache = null
  }
}
