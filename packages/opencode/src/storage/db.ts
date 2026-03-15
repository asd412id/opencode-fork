import { Database as BunDatabase } from "bun:sqlite"
import { Context } from "../util/context"
import { lazy } from "../util/lazy"
import { Global } from "../global"
import { Log } from "../util/log"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"
import path from "path"
import { readFileSync, readdirSync, existsSync, statSync } from "fs"
import { Installation } from "../installation"
import { Flag } from "../flag/flag"
import { iife } from "@/util/iife"

declare const OPENCODE_MIGRATIONS: { sql: string; timestamp: number; name: string }[] | undefined

export const NotFoundError = NamedError.create(
  "NotFoundError",
  z.object({
    message: z.string(),
  }),
)

const log = Log.create({ service: "db" })

export namespace Database {
  export const Path = iife(() => {
    const channel = Installation.CHANNEL
    if (["latest", "beta"].includes(channel) || Flag.OPENCODE_DISABLE_CHANNEL_DB)
      return path.join(Global.Path.data, "opencode.db")
    const safe = channel.replace(/[^a-zA-Z0-9._-]/g, "-")
    return path.join(Global.Path.data, `opencode-${safe}.db`)
  })

  type Journal = { sql: string; timestamp: number; name: string }[]

  const state = {
    sqlite: undefined as BunDatabase | undefined,
  }

  function time(tag: string) {
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(tag)
    if (!match) return 0
    return Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    )
  }

  function migrations(dir: string): Journal {
    const dirs = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)

    const sql = dirs
      .map((name) => {
        const file = path.join(dir, name, "migration.sql")
        if (!existsSync(file)) return
        return {
          sql: readFileSync(file, "utf-8"),
          timestamp: time(name),
          name,
        }
      })
      .filter(Boolean) as Journal

    return sql.sort((a, b) => a.timestamp - b.timestamp)
  }

  function migrate(db: BunDatabase, entries: Journal) {
    db.run(`CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      hash text NOT NULL,
      created_at numeric
    )`)
    const applied = new Set(
      db
        .query<{ hash: string }, []>("SELECT hash FROM __drizzle_migrations")
        .all()
        .map((r) => r.hash),
    )
    for (const entry of entries) {
      const hash = entry.name
      if (applied.has(hash)) continue
      db.run("BEGIN")
      try {
        db.run(entry.sql)
        db.query("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(hash, entry.timestamp)
        db.run("COMMIT")
      } catch (err) {
        db.run("ROLLBACK")
        throw err
      }
    }
  }

  export const Client = lazy(() => {
    log.info("opening database", { path: Path })

    const db = new BunDatabase(Path, { create: true })
    state.sqlite = db

    db.run("PRAGMA journal_mode = WAL")
    db.run("PRAGMA synchronous = NORMAL")
    db.run("PRAGMA busy_timeout = 5000")
    db.run("PRAGMA cache_size = -64000")
    db.run("PRAGMA foreign_keys = ON")
    db.run("PRAGMA wal_checkpoint(PASSIVE)")

    const entries =
      typeof OPENCODE_MIGRATIONS !== "undefined"
        ? OPENCODE_MIGRATIONS
        : migrations(path.join(import.meta.dirname, "../../migration"))
    if (entries.length > 0) {
      log.info("applying migrations", {
        count: entries.length,
        mode: typeof OPENCODE_MIGRATIONS !== "undefined" ? "bundled" : "dev",
      })
      if (Flag.OPENCODE_SKIP_MIGRATIONS) {
        for (const item of entries) {
          item.sql = "select 1;"
        }
      }
      migrate(db, entries)
    }

    return db
  })

  export function close() {
    const db = state.sqlite
    if (!db) return
    db.close()
    state.sqlite = undefined
    Client.reset()
  }

  export function sqlite() {
    Client()
    return state.sqlite!
  }

  const ctx = Context.create<{
    db: BunDatabase
    effects: (() => void | Promise<void>)[]
  }>("database")

  export function use<T>(callback: (db: BunDatabase) => T): T {
    try {
      return callback(ctx.use().db)
    } catch (err) {
      if (err instanceof Context.NotFound) {
        const effects: (() => void | Promise<void>)[] = []
        const result = ctx.provide({ effects, db: Client() }, () => callback(Client()))
        for (const effect of effects) effect()
        return result
      }
      throw err
    }
  }

  export function effect(fn: () => any | Promise<any>) {
    try {
      ctx.use().effects.push(fn)
    } catch {
      fn()
    }
  }

  export function transaction<T>(callback: (db: BunDatabase) => T): T {
    try {
      return callback(ctx.use().db)
    } catch (err) {
      if (err instanceof Context.NotFound) {
        const effects: (() => void | Promise<void>)[] = []
        const db = Client()
        const run = db.transaction(() => {
          return ctx.provide({ db, effects }, () => callback(db))
        })
        const result = run()
        for (const effect of effects) effect()
        return result
      }
      throw err
    }
  }

  export function size(): number {
    try {
      return statSync(Path).size
    } catch {
      return 0
    }
  }

  export function checkpoint() {
    try {
      Client()
      if (!state.sqlite) return
      state.sqlite.run("PRAGMA wal_checkpoint(PASSIVE)")
    } catch (e) {
      log.warn("checkpoint failed", { error: String(e) })
    }
  }

  export function vacuum() {
    try {
      const before = size()
      Client()
      if (!state.sqlite) return
      state.sqlite.run("VACUUM")
      const after = size()
      log.info("vacuum done", {
        before: mb(before),
        after: mb(after),
        saved: mb(before - after),
      })
    } catch (e) {
      log.warn("vacuum failed", { error: String(e) })
    }
  }

  function mb(bytes: number) {
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  }
}
