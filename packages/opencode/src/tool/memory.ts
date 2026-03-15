import z from "zod"
import { Tool } from "./tool"
import { Memory } from "../memory/memory"
import { Instance } from "../project/instance"

export const MemoryReadTool = Tool.define("memory_read", {
  description: `Read a value from persistent project memory by key. Memory persists across sessions.
Use this to recall context, decisions, patterns, or any data you saved previously.
Returns the stored value and tags, or indicates if the key was not found.`,
  parameters: z.object({
    key: z.string().describe("Key to retrieve"),
  }),
  async execute(args) {
    const result = Memory.get(args.key)
    if (!result)
      return {
        title: "not found",
        metadata: { found: false },
        output: `Key "${args.key}" not found in memory.`,
      }
    return {
      title: args.key,
      metadata: { found: true },
      output: JSON.stringify(result.value, null, 2),
    }
  },
})

export const MemoryWriteTool = Tool.define("memory_write", {
  description: `Store a key-value pair in persistent project memory. Memory persists across sessions and survives context compaction.
Use this PROACTIVELY to save:
- Architecture discoveries and code patterns
- Important decisions and their rationale
- File paths and relationships you've discovered
- User preferences and project conventions
- Task progress and pending work

Key naming: use dot notation like "arch.storage", "pattern.naming", "pref.style", "task.current"`,
  parameters: z.object({
    key: z.string().describe("Unique key (use dot notation: arch.x, pattern.x, pref.x, task.x)"),
    value: z.string().describe("Data to store (JSON string or plain text)"),
    tags: z.array(z.string()).optional().describe("Tags for categorization and search"),
  }),
  async execute(args) {
    let parsed: unknown
    try {
      parsed = JSON.parse(args.value)
    } catch {
      parsed = args.value
    }
    Memory.set(args.key, parsed, args.tags)
    return {
      title: args.key,
      metadata: { stored: true },
      output: `Stored "${args.key}" in project memory.`,
    }
  },
})

export const MemorySearchTool = Tool.define("memory_search", {
  description: `Search persistent project memory by key pattern or tags. Use wildcards in pattern (e.g. "arch.*", "*.storage").
Returns matching entries with their values. Use this to find related context when starting a new task or after compaction.`,
  parameters: z.object({
    pattern: z.string().optional().describe("Key pattern with * wildcards (e.g. 'arch.*')"),
    tags: z.array(z.string()).optional().describe("Filter by tags (any match)"),
  }),
  async execute(args) {
    const results = Memory.search({ pattern: args.pattern, tags: args.tags })
    if (results.length === 0)
      return {
        title: "no results",
        metadata: { count: 0 },
        output: "No matching memories found.",
      }
    const lines = results.map(
      (r) => `**${r.key}** [${(r.tags as string[]).join(", ")}]\n${JSON.stringify(r.value, null, 2)}`,
    )
    return {
      title: `${results.length} found`,
      metadata: { count: results.length },
      output: lines.join("\n\n---\n\n"),
    }
  },
})

export const MemoryListTool = Tool.define("memory_list", {
  description: `List all keys in persistent project memory with their tags. Lightweight — does not return values.
Use this to see what's been saved before deciding what to retrieve or store.`,
  parameters: z.object({}),
  async execute() {
    const items = Memory.list()
    if (items.length === 0)
      return {
        title: "empty",
        metadata: { count: 0 },
        output: "No memories stored for this project.",
      }
    const lines = items.map((i) => `- **${i.key}** [${i.tags.join(", ")}]`)
    return {
      title: `${items.length} keys`,
      metadata: { count: items.length },
      output: lines.join("\n"),
    }
  },
})

export const MemoryDeleteTool = Tool.define("memory_delete", {
  description: `Delete a memory entry by key. Use when stored info is outdated or no longer relevant.`,
  parameters: z.object({
    key: z.string().describe("Key to delete"),
  }),
  async execute(args) {
    Memory.remove(args.key)
    return {
      title: args.key,
      metadata: { deleted: true },
      output: `Deleted "${args.key}" from memory.`,
    }
  },
})

export const ContextLogTool = Tool.define("context_log", {
  description: `Log a decision, change, or note to the persistent project tracker. These entries survive across sessions.
Use after making important decisions, completing changes, or discovering notable information.
Types: "decision" (architectural/implementation choices), "change" (file modifications), "note" (observations), "error" (issues found)`,
  parameters: z.object({
    type: z.enum(["decision", "change", "note", "error"]).describe("Entry type"),
    content: z.string().describe("Description of the entry"),
    tags: z.array(z.string()).optional().describe("Tags for categorization"),
  }),
  async execute(args, ctx) {
    Memory.log_entry({
      session: ctx.sessionID,
      type: args.type,
      content: args.content,
      tags: args.tags,
    })
    return {
      title: args.type,
      metadata: { logged: true },
      output: `Logged ${args.type}: ${args.content}`,
    }
  },
})

export const ContextStatusTool = Tool.define("context_status", {
  description: `Check memory status and recent activity for this project. Shows:
- Number of stored memories
- Recent tracker entries (decisions, changes, notes)
- Current RAM usage and GC pressure

Use this proactively to:
1. At session start: check what context was saved from previous sessions
2. During long sessions: monitor memory pressure
3. Before reporting done: verify all changes are tracked`,
  parameters: z.object({
    session: z.string().optional().describe("Filter by session ID"),
  }),
  async execute(args) {
    const status = Memory.status(args.session)
    const mem = process.memoryUsage()
    const limit = 3 * 1024 * 1024 * 1024
    const pressure = ((mem.rss / limit) * 100).toFixed(1)

    const lines = [
      "## Memory Status",
      `- Stored memories: ${status.memories}`,
      `- RAM: ${(mem.rss / 1024 / 1024).toFixed(0)}MB / ${(limit / 1024 / 1024).toFixed(0)}MB (${pressure}%)`,
      `- Heap: ${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB`,
      "",
      "## Tracker Counts",
      ...status.counts.map((c) => `- ${c.type}: ${c.cnt}`),
      "",
      "## Recent Activity",
      ...status.recent.map((r) => `- [${r.type}] ${r.content.slice(0, 100)}${r.content.length > 100 ? "..." : ""}`),
    ]

    return {
      title: `${status.memories} memories`,
      metadata: { memories: status.memories, pressure: parseFloat(pressure) },
      output: lines.join("\n"),
    }
  },
})
