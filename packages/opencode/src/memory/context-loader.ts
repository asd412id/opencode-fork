import { Memory } from "./memory"

export namespace MemoryContext {
  const RELEVANCE_KEYWORDS = [
    "architecture",
    "pattern",
    "structure",
    "design",
    "convention",
    "config",
    "configuration",
    "setup",
    "install",
    "auth",
    "authentication",
    "login",
    "permission",
    "access",
    "database",
    "db",
    "schema",
    "migration",
    "model",
    "api",
    "endpoint",
    "route",
    "server",
    "client",
    "test",
    "testing",
    "spec",
    "mock",
    "build",
    "deploy",
    "ci",
    "cd",
    "pipeline",
    "error",
    "bug",
    "issue",
    "fix",
    "debug",
    "feature",
    "implementation",
    "refactor",
    "optimize",
  ]

  const injectedSessions = new Set<string>()

  function extractKeywords(text: string): string[] {
    const lower = text.toLowerCase()
    return RELEVANCE_KEYWORDS.filter((kw) => lower.includes(kw))
  }

  function calculateRelevance(memory: { key: string; tags: string[] }, query: string): number {
    const keywords = extractKeywords(query)
    let score = 0

    const keyLower = memory.key.toLowerCase()
    const tagsLower = memory.tags.join(" ").toLowerCase()

    for (const kw of keywords) {
      if (keyLower.includes(kw)) score += 3
      if (tagsLower.includes(kw)) score += 2
    }

    return score
  }

  export function isInjected(sessionID: string): boolean {
    return injectedSessions.has(sessionID)
  }

  export function markInjected(sessionID: string): void {
    injectedSessions.add(sessionID)
  }

  export function clearInjected(sessionID: string): void {
    injectedSessions.delete(sessionID)
  }

  export async function suggestRelevant(input: {
    sessionID: string
    userMessage: string
  }): Promise<{ key: string; value: unknown; tags: string[]; relevance: number }[]> {
    if (!input.userMessage || input.userMessage.length < 10) {
      return []
    }

    const memories = Memory.list()
    if (memories.length === 0) {
      return []
    }

    const scored = memories
      .map((mem) => {
        try {
          const full = Memory.get(mem.key)
          if (!full) return null
          return {
            ...full,
            relevance: calculateRelevance(mem, input.userMessage),
          }
        } catch {
          return null
        }
      })
      .filter((m): m is { key: string; value: unknown; tags: string[]; relevance: number } => m !== null)
      .sort((a, b) => b.relevance - a.relevance)

    return scored.slice(0, 3)
  }

  export async function injectRelevantAsContext(input: { sessionID: string; userMessage: string }): Promise<boolean> {
    if (injectedSessions.has(input.sessionID)) {
      return false
    }

    const relevant = await suggestRelevant(input)

    if (relevant.length === 0) {
      return false
    }

    const entries = relevant
      .filter((mem) => mem.relevance > 0)
      .map((mem) => {
        const preview =
          typeof mem.value === "string" ? mem.value.slice(0, 300) : JSON.stringify(mem.value).slice(0, 300)
        return {
          session: input.sessionID,
          type: "note" as const,
          content: `[Relevant Memory] ${mem.key}: ${preview}${preview.length >= 300 ? "..." : ""}`,
          tags: ["memory", "suggested", ...mem.tags],
        }
      })

    if (entries.length === 0) {
      return false
    }

    for (const entry of entries) {
      try {
        Memory.log_entry(entry)
      } catch {
        // Silently ignore logging errors
      }
    }

    injectedSessions.add(input.sessionID)
    return true
  }
}
