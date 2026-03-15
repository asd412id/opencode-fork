import { Database } from "bun:sqlite"
import path from "path"
import { Global } from "../global"
import { Log } from "../util/log"
import { Instance } from "../project/instance"
import fs from "fs"

export namespace Memory {
  const log = Log.create({ service: "memory" })

  const SCHEMA = `
    CREATE TABLE IF NOT EXISTS memory (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_memory_expires ON memory(expires_at);

    CREATE TABLE IF NOT EXISTS context (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      metadata TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_context_session ON context(session_id);
    CREATE INDEX IF NOT EXISTS idx_context_type ON context(type);
  `

  const pool = new Map<string, Database>()

  function dir() {
    const base = path.join(Global.Path.data, "memory")
    if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true })
    return base
  }

  function db(): Database {
    const pid = Instance.project.id
    const cached = pool.get(pid)
    if (cached) return cached

    const file = path.join(dir(), `${pid}.db`)
    const conn = new Database(file, { create: true })
    conn.run("PRAGMA journal_mode = WAL")
    conn.run("PRAGMA synchronous = NORMAL")
    conn.run("PRAGMA busy_timeout = 3000")
    conn.exec(SCHEMA)

    pool.set(pid, conn)
    return conn
  }

  export function set(key: string, value: unknown, tags?: string[], ttl?: number) {
    const now = Date.now()
    const expires = ttl ? now + ttl : null
    db().run(
      `INSERT INTO memory (key, value, tags, created_at, updated_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?4, ?5)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         tags = excluded.tags,
         updated_at = excluded.updated_at,
         expires_at = excluded.expires_at`,
      [key, JSON.stringify(value), JSON.stringify(tags ?? []), now, expires],
    )
  }

  export function get(key: string): { key: string; value: unknown; tags: string[] } | undefined {
    cleanup()
    const row = db()
      .query<{ key: string; value: string; tags: string }, [string]>(
        "SELECT key, value, tags FROM memory WHERE key = ?1 AND (expires_at IS NULL OR expires_at > ?2)",
      )
      .get(key, Date.now() as any)
    if (!row) return undefined
    return {
      key: row.key,
      value: JSON.parse(row.value),
      tags: JSON.parse(row.tags),
    }
  }

  export function remove(key: string) {
    db().run("DELETE FROM memory WHERE key = ?1", [key])
  }

  export function list(): { key: string; tags: string[] }[] {
    cleanup()
    const rows = db()
      .query<{ key: string; tags: string }, []>(
        "SELECT key, tags FROM memory WHERE expires_at IS NULL OR expires_at > ?1 ORDER BY updated_at DESC",
      )
      .all(Date.now() as any)
    return rows.map((r) => ({ key: r.key, tags: JSON.parse(r.tags) }))
  }

  export function search(opts: {
    pattern?: string
    tags?: string[]
  }): { key: string; value: unknown; tags: string[] }[] {
    cleanup()
    let sql = "SELECT key, value, tags FROM memory WHERE (expires_at IS NULL OR expires_at > ?1)"
    const params: unknown[] = [Date.now()]
    let idx = 2

    if (opts.pattern) {
      const like = opts.pattern.replace(/\*/g, "%")
      sql += ` AND key LIKE ?${idx}`
      params.push(like)
      idx++
    }

    if (opts.tags?.length) {
      for (const tag of opts.tags) {
        sql += ` AND tags LIKE ?${idx}`
        params.push(`%"${tag}"%`)
        idx++
      }
    }

    sql += " ORDER BY updated_at DESC"
    const rows = db()
      .query<{ key: string; value: string; tags: string }, any[]>(sql)
      .all(...params)
    return rows.map((r) => ({
      key: r.key,
      value: JSON.parse(r.value),
      tags: JSON.parse(r.tags),
    }))
  }

  export function update(key: string, value: unknown, tags?: string[]) {
    const now = Date.now()
    const existing = get(key)
    if (!existing) return set(key, value, tags)

    const merged =
      typeof value === "object" && typeof existing.value === "object"
        ? { ...(existing.value as any), ...(value as any) }
        : value
    const merged_tags = tags ?? existing.tags

    db().run("UPDATE memory SET value = ?1, tags = ?2, updated_at = ?3 WHERE key = ?4", [
      JSON.stringify(merged),
      JSON.stringify(merged_tags),
      now,
      key,
    ])
  }

  function cleanup() {
    db().run("DELETE FROM memory WHERE expires_at IS NOT NULL AND expires_at <= ?1", [Date.now()])
  }

  export function clear(tags?: string[]) {
    if (!tags) {
      db().run("DELETE FROM memory")
      return
    }
    for (const tag of tags) {
      db().run("DELETE FROM memory WHERE tags LIKE ?1", [`%"${tag}"%`])
    }
  }

  // --- Context tracker (decisions, changes, todos, notes, errors) ---

  export function log_entry(input: {
    session: string
    type: "decision" | "change" | "todo" | "note" | "error"
    content: string
    tags?: string[]
    metadata?: unknown
  }) {
    db().run(
      `INSERT INTO context (session_id, type, content, tags, metadata, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      [
        input.session,
        input.type,
        input.content,
        JSON.stringify(input.tags ?? []),
        input.metadata ? JSON.stringify(input.metadata) : null,
        Date.now(),
      ],
    )
  }

  export function search_context(opts: {
    session?: string
    type?: string
    query?: string
    tags?: string[]
    limit?: number
  }) {
    let sql = "SELECT id, session_id, type, content, tags, metadata, created_at FROM context WHERE 1=1"
    const params: unknown[] = []
    let idx = 1

    if (opts.session) {
      sql += ` AND session_id = ?${idx}`
      params.push(opts.session)
      idx++
    }
    if (opts.type) {
      sql += ` AND type = ?${idx}`
      params.push(opts.type)
      idx++
    }
    if (opts.query) {
      sql += ` AND content LIKE ?${idx}`
      params.push(`%${opts.query}%`)
      idx++
    }
    if (opts.tags?.length) {
      for (const tag of opts.tags) {
        sql += ` AND tags LIKE ?${idx}`
        params.push(`%"${tag}"%`)
        idx++
      }
    }

    sql += ` ORDER BY created_at DESC LIMIT ?${idx}`
    params.push(opts.limit ?? 50)

    const rows = db()
      .query<
        {
          id: number
          session_id: string
          type: string
          content: string
          tags: string
          metadata: string | null
          created_at: number
        },
        any[]
      >(sql)
      .all(...params)

    return rows.map((r) => ({
      id: r.id,
      session: r.session_id,
      type: r.type,
      content: r.content,
      tags: JSON.parse(r.tags),
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
      created: r.created_at,
    }))
  }

  export function status(session?: string) {
    const where = session ? "WHERE session_id = ?1" : ""
    const params = session ? [session] : []

    const counts = db()
      .query<{ type: string; cnt: number }, any[]>(`SELECT type, count(*) as cnt FROM context ${where} GROUP BY type`)
      .all(...params)

    const recent = db()
      .query<{ type: string; content: string; created_at: number }, any[]>(
        `SELECT type, content, created_at FROM context ${where} ORDER BY created_at DESC LIMIT 10`,
      )
      .all(...params)

    const memories = list()

    return { counts, recent, memories: memories.length }
  }

  export function cleanupContext(olderThanMs: number = 7 * 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - olderThanMs
    try {
      db().run("DELETE FROM context WHERE created_at < ? AND type = 'note' AND content LIKE '%[Relevant Memory]%'", [
        cutoff,
      ])
    } catch {
      // Silently ignore cleanup errors
    }
  }

  export function closeAll() {
    for (const [, conn] of pool) {
      try {
        conn.close()
      } catch {}
    }
    pool.clear()
  }
}
