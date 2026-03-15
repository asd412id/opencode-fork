import { Database } from "bun:sqlite"
import { Global } from "../global"
import { Log } from "../util/log"
import path from "path"
import { existsSync } from "fs"
import { Filesystem } from "../util/filesystem"
import { Glob } from "../util/glob"

export namespace JsonMigration {
  const log = Log.create({ service: "json-migration" })

  export type Progress = {
    current: number
    total: number
    label: string
  }

  type Options = {
    progress?: (event: Progress) => void
  }

  export async function run(sqlite: Database, options?: Options) {
    const storageDir = path.join(Global.Path.data, "storage")

    if (!existsSync(storageDir)) {
      log.info("storage directory does not exist, skipping migration")
      return {
        projects: 0,
        sessions: 0,
        messages: 0,
        parts: 0,
        todos: 0,
        permissions: 0,
        shares: 0,
        errors: [] as string[],
      }
    }

    log.info("starting json to sqlite migration", { storageDir })
    const start = performance.now()

    // Optimize SQLite for bulk inserts
    sqlite.exec("PRAGMA journal_mode = WAL")
    sqlite.exec("PRAGMA synchronous = OFF")
    sqlite.exec("PRAGMA cache_size = 10000")
    sqlite.exec("PRAGMA temp_store = MEMORY")
    const stats = {
      projects: 0,
      sessions: 0,
      messages: 0,
      parts: 0,
      todos: 0,
      permissions: 0,
      shares: 0,
      errors: [] as string[],
    }
    const orphans = {
      sessions: 0,
      todos: 0,
      permissions: 0,
      shares: 0,
    }
    const errs = stats.errors

    const batchSize = 1000
    const now = Date.now()

    async function list(pattern: string) {
      return Glob.scan(pattern, { cwd: storageDir, absolute: true })
    }

    async function read(files: string[], start: number, end: number) {
      const count = end - start
      const tasks = new Array(count)
      for (let i = 0; i < count; i++) {
        tasks[i] = Filesystem.readJson(files[start + i])
      }
      const results = await Promise.allSettled(tasks)
      const items = new Array(count)
      for (let i = 0; i < results.length; i++) {
        const result = results[i]
        if (result.status === "fulfilled") {
          items[i] = result.value
          continue
        }
        errs.push(`failed to read ${files[start + i]}: ${result.reason}`)
      }
      return items
    }

    // Pre-scan all files upfront to avoid repeated glob operations
    log.info("scanning files...")
    const [projectFiles, sessionFiles, messageFiles, partFiles, todoFiles, permFiles, shareFiles] = await Promise.all([
      list("project/*.json"),
      list("session/*/*.json"),
      list("message/*/*.json"),
      list("part/*/*.json"),
      list("todo/*.json"),
      list("permission/*.json"),
      list("session_share/*.json"),
    ])

    log.info("file scan complete", {
      projects: projectFiles.length,
      sessions: sessionFiles.length,
      messages: messageFiles.length,
      parts: partFiles.length,
      todos: todoFiles.length,
      permissions: permFiles.length,
      shares: shareFiles.length,
    })

    const total = Math.max(
      1,
      projectFiles.length +
        sessionFiles.length +
        messageFiles.length +
        partFiles.length +
        todoFiles.length +
        permFiles.length +
        shareFiles.length,
    )
    const progress = options?.progress
    let current = 0
    const step = (label: string, count: number) => {
      current = Math.min(total, current + count)
      progress?.({ current, total, label })
    }

    progress?.({ current, total, label: "starting" })

    sqlite.exec("BEGIN TRANSACTION")

    // Prepared statements for batch inserts
    const stmts = {
      project: sqlite.query(
        `INSERT OR IGNORE INTO project (id, worktree, vcs, name, icon_url, icon_color, time_created, time_updated, time_initialized, sandboxes, commands) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      session: sqlite.query(
        `INSERT OR IGNORE INTO session (id, project_id, parent_id, slug, directory, title, version, share_url, summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission, time_created, time_updated, time_compacting, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      message: sqlite.query(
        `INSERT OR IGNORE INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`,
      ),
      part: sqlite.query(
        `INSERT OR IGNORE INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`,
      ),
      todo: sqlite.query(
        `INSERT OR IGNORE INTO todo (session_id, content, status, priority, position, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ),
      permission: sqlite.query(`INSERT OR IGNORE INTO permission (project_id, data) VALUES (?, ?)`),
      share: sqlite.query(`INSERT OR IGNORE INTO session_share (session_id, id, secret, url) VALUES (?, ?, ?, ?)`),
    }

    // Migrate projects first (no FK deps)
    // Derive all IDs from file paths, not JSON content
    const projectIds = new Set<string>()
    for (let i = 0; i < projectFiles.length; i += batchSize) {
      const end = Math.min(i + batchSize, projectFiles.length)
      const batch = await read(projectFiles, i, end)
      for (let j = 0; j < batch.length; j++) {
        const data = batch[j]
        if (!data) continue
        const id = path.basename(projectFiles[i + j], ".json")
        projectIds.add(id)
        try {
          stmts.project.run(
            id,
            data.worktree ?? "/",
            data.vcs,
            data.name ?? null,
            data.icon?.url ?? null,
            data.icon?.color ?? null,
            data.time?.created ?? now,
            data.time?.updated ?? now,
            data.time?.initialized ?? null,
            JSON.stringify(data.sandboxes ?? []),
            data.commands ? JSON.stringify(data.commands) : null,
          )
          stats.projects++
        } catch (e) {
          errs.push(`failed to migrate project ${id}: ${e}`)
        }
      }
      step("projects", end - i)
    }
    log.info("migrated projects", { count: stats.projects, duration: Math.round(performance.now() - start) })

    // Migrate sessions (depends on projects)
    // Derive all IDs from directory/file paths, not JSON content, since earlier
    // migrations may have moved sessions to new directories without updating the JSON
    const sessionProjects = sessionFiles.map((file) => path.basename(path.dirname(file)))
    const sessionIds = new Set<string>()
    for (let i = 0; i < sessionFiles.length; i += batchSize) {
      const end = Math.min(i + batchSize, sessionFiles.length)
      const batch = await read(sessionFiles, i, end)
      for (let j = 0; j < batch.length; j++) {
        const data = batch[j]
        if (!data) continue
        const id = path.basename(sessionFiles[i + j], ".json")
        const projectID = sessionProjects[i + j]
        if (!projectIds.has(projectID)) {
          orphans.sessions++
          continue
        }
        sessionIds.add(id)
        try {
          stmts.session.run(
            id,
            projectID,
            data.parentID ?? null,
            data.slug ?? "",
            data.directory ?? "",
            data.title ?? "",
            data.version ?? "",
            data.share?.url ?? null,
            data.summary?.additions ?? null,
            data.summary?.deletions ?? null,
            data.summary?.files ?? null,
            data.summary?.diffs ? JSON.stringify(data.summary.diffs) : null,
            data.revert ? JSON.stringify(data.revert) : null,
            data.permission ? JSON.stringify(data.permission) : null,
            data.time?.created ?? now,
            data.time?.updated ?? now,
            data.time?.compacting ?? null,
            data.time?.archived ?? null,
          )
          stats.sessions++
        } catch (e) {
          errs.push(`failed to migrate session ${id}: ${e}`)
        }
      }
      step("sessions", end - i)
    }
    log.info("migrated sessions", { count: stats.sessions })
    if (orphans.sessions > 0) {
      log.warn("skipped orphaned sessions", { count: orphans.sessions })
    }

    // Migrate messages using pre-scanned file map
    const allMessageFiles = [] as string[]
    const allMessageSessions = [] as string[]
    const messageSessions = new Map<string, string>()
    for (const file of messageFiles) {
      const sessionID = path.basename(path.dirname(file))
      if (!sessionIds.has(sessionID)) continue
      allMessageFiles.push(file)
      allMessageSessions.push(sessionID)
    }

    for (let i = 0; i < allMessageFiles.length; i += batchSize) {
      const end = Math.min(i + batchSize, allMessageFiles.length)
      const batch = await read(allMessageFiles, i, end)
      for (let j = 0; j < batch.length; j++) {
        const data = batch[j]
        if (!data) continue
        const file = allMessageFiles[i + j]
        const id = path.basename(file, ".json")
        const sessionID = allMessageSessions[i + j]
        messageSessions.set(id, sessionID)
        const rest = data
        delete rest.id
        delete rest.sessionID
        try {
          stmts.message.run(id, sessionID, data.time?.created ?? now, data.time?.updated ?? now, JSON.stringify(rest))
          stats.messages++
        } catch (e) {
          errs.push(`failed to migrate message ${id}: ${e}`)
        }
      }
      step("messages", end - i)
    }
    log.info("migrated messages", { count: stats.messages })

    // Migrate parts using pre-scanned file map
    for (let i = 0; i < partFiles.length; i += batchSize) {
      const end = Math.min(i + batchSize, partFiles.length)
      const batch = await read(partFiles, i, end)
      for (let j = 0; j < batch.length; j++) {
        const data = batch[j]
        if (!data) continue
        const file = partFiles[i + j]
        const id = path.basename(file, ".json")
        const messageID = path.basename(path.dirname(file))
        const sessionID = messageSessions.get(messageID)
        if (!sessionID) {
          errs.push(`part missing message session: ${file}`)
          continue
        }
        if (!sessionIds.has(sessionID)) continue
        const rest = data
        delete rest.id
        delete rest.messageID
        delete rest.sessionID
        try {
          stmts.part.run(
            id,
            messageID,
            sessionID,
            data.time?.created ?? now,
            data.time?.updated ?? now,
            JSON.stringify(rest),
          )
          stats.parts++
        } catch (e) {
          errs.push(`failed to migrate part ${id}: ${e}`)
        }
      }
      step("parts", end - i)
    }
    log.info("migrated parts", { count: stats.parts })

    // Migrate todos
    const todoSessions = todoFiles.map((file) => path.basename(file, ".json"))
    for (let i = 0; i < todoFiles.length; i += batchSize) {
      const end = Math.min(i + batchSize, todoFiles.length)
      const batch = await read(todoFiles, i, end)
      for (let j = 0; j < batch.length; j++) {
        const data = batch[j]
        if (!data) continue
        const sessionID = todoSessions[i + j]
        if (!sessionIds.has(sessionID)) {
          orphans.todos++
          continue
        }
        if (!Array.isArray(data)) {
          errs.push(`todo not an array: ${todoFiles[i + j]}`)
          continue
        }
        for (let position = 0; position < data.length; position++) {
          const todo = data[position]
          if (!todo?.content || !todo?.status || !todo?.priority) continue
          try {
            stmts.todo.run(sessionID, todo.content, todo.status, todo.priority, position, now, now)
            stats.todos++
          } catch (e) {
            errs.push(`failed to migrate todo for session ${sessionID}: ${e}`)
          }
        }
      }
      step("todos", end - i)
    }
    log.info("migrated todos", { count: stats.todos })
    if (orphans.todos > 0) {
      log.warn("skipped orphaned todos", { count: orphans.todos })
    }

    // Migrate permissions
    const permProjects = permFiles.map((file) => path.basename(file, ".json"))
    for (let i = 0; i < permFiles.length; i += batchSize) {
      const end = Math.min(i + batchSize, permFiles.length)
      const batch = await read(permFiles, i, end)
      for (let j = 0; j < batch.length; j++) {
        const data = batch[j]
        if (!data) continue
        const projectID = permProjects[i + j]
        if (!projectIds.has(projectID)) {
          orphans.permissions++
          continue
        }
        try {
          stmts.permission.run(projectID, JSON.stringify(data))
          stats.permissions++
        } catch (e) {
          errs.push(`failed to migrate permission for project ${projectID}: ${e}`)
        }
      }
      step("permissions", end - i)
    }
    log.info("migrated permissions", { count: stats.permissions })
    if (orphans.permissions > 0) {
      log.warn("skipped orphaned permissions", { count: orphans.permissions })
    }

    // Migrate session shares
    const shareSessions = shareFiles.map((file) => path.basename(file, ".json"))
    for (let i = 0; i < shareFiles.length; i += batchSize) {
      const end = Math.min(i + batchSize, shareFiles.length)
      const batch = await read(shareFiles, i, end)
      for (let j = 0; j < batch.length; j++) {
        const data = batch[j]
        if (!data) continue
        const sessionID = shareSessions[i + j]
        if (!sessionIds.has(sessionID)) {
          orphans.shares++
          continue
        }
        if (!data?.id || !data?.secret || !data?.url) {
          errs.push(`session_share missing id/secret/url: ${shareFiles[i + j]}`)
          continue
        }
        try {
          stmts.share.run(sessionID, data.id, data.secret, data.url)
          stats.shares++
        } catch (e) {
          errs.push(`failed to migrate session_share for session ${sessionID}: ${e}`)
        }
      }
      step("shares", end - i)
    }
    log.info("migrated session shares", { count: stats.shares })
    if (orphans.shares > 0) {
      log.warn("skipped orphaned session shares", { count: orphans.shares })
    }

    sqlite.exec("COMMIT")

    log.info("json migration complete", {
      projects: stats.projects,
      sessions: stats.sessions,
      messages: stats.messages,
      parts: stats.parts,
      todos: stats.todos,
      permissions: stats.permissions,
      shares: stats.shares,
      errorCount: stats.errors.length,
      duration: Math.round(performance.now() - start),
    })

    if (stats.errors.length > 0) {
      log.warn("migration errors", { errors: stats.errors.slice(0, 20) })
    }

    progress?.({ current: total, total, label: "complete" })

    return stats
  }
}
