import { Slug } from "@opencode-ai/util/slug"
import path from "path"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Decimal } from "decimal.js"
import z from "zod"
import { type ProviderMetadata } from "ai"
import { Config } from "../config/config"
import { Flag } from "../flag/flag"
import { Installation } from "../installation"

import { Database, NotFoundError } from "../storage/db"
import type { SessionRow } from "./session.sql"
import { SessionDiff } from "./session-diff.sql"
import { Log } from "../util/log"
import { MessageV2 } from "./message-v2"
import { Instance } from "../project/instance"
import { SessionPrompt } from "./prompt"
import { fn } from "@/util/fn"
import { Command } from "../command"
import { Snapshot } from "@/snapshot"
import { WorkspaceContext } from "../control-plane/workspace-context"
import { ProjectID } from "../project/schema"
import { WorkspaceID } from "../control-plane/schema"
import { SessionID, MessageID, PartID } from "./schema"

import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { PermissionNext } from "@/permission/next"
import { Global } from "@/global"
import type { LanguageModelV2Usage } from "@ai-sdk/provider"
import { iife } from "@/util/iife"

export namespace Session {
  const log = Log.create({ service: "session" })

  const parentTitlePrefix = "New session - "
  const childTitlePrefix = "Child session - "

  function createDefaultTitle(isChild = false) {
    return (isChild ? childTitlePrefix : parentTitlePrefix) + new Date().toISOString()
  }

  export function isDefaultTitle(title: string) {
    return new RegExp(
      `^(${parentTitlePrefix}|${childTitlePrefix})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`,
    ).test(title)
  }

  function parseSession(row: SessionRow): SessionRow {
    return {
      ...row,
      summary_diffs: row.summary_diffs ? JSON.parse(row.summary_diffs as any) : null,
      revert: row.revert ? JSON.parse(row.revert as any) : null,
      permission: row.permission ? JSON.parse(row.permission as any) : null,
    }
  }

  export function fromRow(row: SessionRow): Info {
    const parsed = parseSession(row)
    const summary =
      parsed.summary_additions !== null || parsed.summary_deletions !== null || parsed.summary_files !== null
        ? {
            additions: parsed.summary_additions ?? 0,
            deletions: parsed.summary_deletions ?? 0,
            files: parsed.summary_files ?? 0,
            diffs: parsed.summary_diffs ?? undefined,
          }
        : undefined
    const share = parsed.share_url ? { url: parsed.share_url } : undefined
    const revert = parsed.revert ?? undefined
    return {
      id: parsed.id,
      slug: parsed.slug,
      projectID: parsed.project_id,
      workspaceID: parsed.workspace_id ?? undefined,
      directory: parsed.directory,
      parentID: parsed.parent_id ?? undefined,
      title: parsed.title,
      version: parsed.version,
      summary,
      share,
      revert,
      permission: parsed.permission ?? undefined,
      time: {
        created: parsed.time_created,
        updated: parsed.time_updated,
        compacting: parsed.time_compacting ?? undefined,
        archived: parsed.time_archived ?? undefined,
      },
    }
  }

  export function toRow(info: Info) {
    return {
      id: info.id,
      project_id: info.projectID,
      workspace_id: info.workspaceID,
      parent_id: info.parentID,
      slug: info.slug,
      directory: info.directory,
      title: info.title,
      version: info.version,
      share_url: info.share?.url,
      summary_additions: info.summary?.additions,
      summary_deletions: info.summary?.deletions,
      summary_files: info.summary?.files,
      summary_diffs: info.summary?.diffs ? JSON.stringify(info.summary.diffs) : null,
      revert: info.revert ? JSON.stringify(info.revert) : null,
      permission: info.permission ? JSON.stringify(info.permission) : null,
      time_created: info.time.created,
      time_updated: info.time.updated,
      time_compacting: info.time.compacting,
      time_archived: info.time.archived,
    }
  }

  function getForkedTitle(title: string): string {
    const match = title.match(/^(.+) \(fork #(\d+)\)$/)
    if (match) {
      const base = match[1]
      const num = parseInt(match[2], 10)
      return `${base} (fork #${num + 1})`
    }
    return `${title} (fork #1)`
  }

  export const Info = z
    .object({
      id: SessionID.zod,
      slug: z.string(),
      projectID: ProjectID.zod,
      workspaceID: WorkspaceID.zod.optional(),
      directory: z.string(),
      parentID: SessionID.zod.optional(),
      summary: z
        .object({
          additions: z.number(),
          deletions: z.number(),
          files: z.number(),
          diffs: Snapshot.FileDiff.array().optional(),
        })
        .optional(),
      share: z
        .object({
          url: z.string(),
        })
        .optional(),
      title: z.string(),
      version: z.string(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        compacting: z.number().optional(),
        archived: z.number().optional(),
      }),
      permission: PermissionNext.Ruleset.optional(),
      revert: z
        .object({
          messageID: MessageID.zod,
          partID: PartID.zod.optional(),
          snapshot: z.string().optional(),
          diff: z.string().optional(),
        })
        .optional(),
    })
    .meta({
      ref: "Session",
    })
  export type Info = z.output<typeof Info>

  export const ProjectInfo = z
    .object({
      id: ProjectID.zod,
      name: z.string().optional(),
      worktree: z.string(),
    })
    .meta({
      ref: "ProjectSummary",
    })
  export type ProjectInfo = z.output<typeof ProjectInfo>

  export const GlobalInfo = Info.extend({
    project: ProjectInfo.nullable(),
  }).meta({
    ref: "GlobalSession",
  })
  export type GlobalInfo = z.output<typeof GlobalInfo>

  export const Event = {
    Created: BusEvent.define(
      "session.created",
      z.object({
        info: Info,
      }),
    ),
    Updated: BusEvent.define(
      "session.updated",
      z.object({
        info: Info,
      }),
    ),
    Deleted: BusEvent.define(
      "session.deleted",
      z.object({
        info: Info,
      }),
    ),
    Diff: BusEvent.define(
      "session.diff",
      z.object({
        sessionID: SessionID.zod,
        diff: Snapshot.FileDiff.array(),
      }),
    ),
    Error: BusEvent.define(
      "session.error",
      z.object({
        sessionID: SessionID.zod.optional(),
        error: MessageV2.Assistant.shape.error,
      }),
    ),
  }

  export const create = fn(
    z
      .object({
        parentID: SessionID.zod.optional(),
        title: z.string().optional(),
        permission: Info.shape.permission,
        workspaceID: WorkspaceID.zod.optional(),
      })
      .optional(),
    async (input) => {
      return createNext({
        parentID: input?.parentID,
        directory: Instance.directory,
        title: input?.title,
        permission: input?.permission,
        workspaceID: input?.workspaceID,
      })
    },
  )

  export const fork = fn(
    z.object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod.optional(),
    }),
    async (input) => {
      const original = await get(input.sessionID)
      if (!original) throw new Error("session not found")
      const title = getForkedTitle(original.title)
      const session = await createNext({
        directory: Instance.directory,
        workspaceID: original.workspaceID,
        title,
      })
      const msgs = await messages({ sessionID: input.sessionID })
      const idMap = new Map<string, MessageID>()

      for (const msg of msgs) {
        if (input.messageID && msg.info.id >= input.messageID) break
        const newID = MessageID.ascending()
        idMap.set(msg.info.id, newID)

        const parentID = msg.info.role === "assistant" && msg.info.parentID ? idMap.get(msg.info.parentID) : undefined
        const cloned = await updateMessage({
          ...msg.info,
          sessionID: session.id,
          id: newID,
          ...(parentID && { parentID }),
        })

        for (const part of msg.parts) {
          await updatePart({
            ...part,
            id: PartID.ascending(),
            messageID: cloned.id,
            sessionID: session.id,
          })
        }
      }
      return session
    },
  )

  export const touch = fn(SessionID.zod, async (sessionID) => {
    const now = Date.now()
    Database.use((db) => {
      const row = db
        .query<SessionRow, [number, string]>("UPDATE session SET time_updated = ? WHERE id = ? RETURNING *")
        .get(now, sessionID)
      if (!row) throw new NotFoundError({ message: `Session not found: ${sessionID}` })
      const info = fromRow(row)
      Database.effect(() => Bus.publish(Event.Updated, { info }))
    })
  })

  export async function createNext(input: {
    id?: SessionID
    title?: string
    parentID?: SessionID
    workspaceID?: WorkspaceID
    directory: string
    permission?: PermissionNext.Ruleset
  }) {
    const result: Info = {
      id: SessionID.descending(input.id),
      slug: Slug.create(),
      version: Installation.VERSION,
      projectID: Instance.project.id,
      directory: input.directory,
      workspaceID: input.workspaceID,
      parentID: input.parentID,
      title: input.title ?? createDefaultTitle(!!input.parentID),
      permission: input.permission,
      time: {
        created: Date.now(),
        updated: Date.now(),
      },
    }
    log.info("created", result)
    const row = toRow(result)
    Database.use((db) => {
      db.query(
        `INSERT INTO session (id, project_id, workspace_id, parent_id, slug, directory, title, version, share_url, summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission, time_created, time_updated, time_compacting, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        row.project_id,
        row.workspace_id ?? null,
        row.parent_id ?? null,
        row.slug,
        row.directory,
        row.title,
        row.version,
        row.share_url ?? null,
        row.summary_additions ?? null,
        row.summary_deletions ?? null,
        row.summary_files ?? null,
        row.summary_diffs ?? null,
        row.revert ?? null,
        row.permission ?? null,
        row.time_created,
        row.time_updated,
        row.time_compacting ?? null,
        row.time_archived ?? null,
      )
      Database.effect(() =>
        Bus.publish(Event.Created, {
          info: result,
        }),
      )
    })
    const cfg = await Config.get()
    if (!result.parentID && (Flag.OPENCODE_AUTO_SHARE || cfg.share === "auto"))
      share(result.id).catch(() => {
        // Silently ignore sharing errors during session creation
      })
    Bus.publish(Event.Updated, {
      info: result,
    })
    return result
  }

  export function plan(input: { slug: string; time: { created: number } }) {
    const base = Instance.project.vcs
      ? path.join(Instance.worktree, ".opencode", "plans")
      : path.join(Global.Path.data, "plans")
    return path.join(base, [input.time.created, input.slug].join("-") + ".md")
  }

  export const get = fn(SessionID.zod, async (id) => {
    const row = Database.use((db) => db.query<SessionRow, [string]>("SELECT * FROM session WHERE id = ?").get(id))
    if (!row) throw new NotFoundError({ message: `Session not found: ${id}` })
    return fromRow(row)
  })

  export const share = fn(SessionID.zod, async (id) => {
    const cfg = await Config.get()
    if (cfg.share === "disabled") {
      throw new Error("Sharing is disabled in configuration")
    }
    const { ShareNext } = await import("@/share/share-next")
    const share = await ShareNext.create(id)
    Database.use((db) => {
      const now = Date.now()
      const row = db
        .query<
          SessionRow,
          [string, number, string]
        >("UPDATE session SET share_url = ?, time_updated = ? WHERE id = ? RETURNING *")
        .get(share.url, now, id)
      if (!row) throw new NotFoundError({ message: `Session not found: ${id}` })
      const info = fromRow(row)
      Database.effect(() => Bus.publish(Event.Updated, { info }))
    })
    return share
  })

  export const unshare = fn(SessionID.zod, async (id) => {
    // Use ShareNext to remove the share (same as share function uses ShareNext to create)
    const { ShareNext } = await import("@/share/share-next")
    await ShareNext.remove(id)
    Database.use((db) => {
      const now = Date.now()
      const row = db
        .query<
          SessionRow,
          [null, number, string]
        >("UPDATE session SET share_url = ?, time_updated = ? WHERE id = ? RETURNING *")
        .get(null, now, id)
      if (!row) throw new NotFoundError({ message: `Session not found: ${id}` })
      const info = fromRow(row)
      Database.effect(() => Bus.publish(Event.Updated, { info }))
    })
  })

  export const setTitle = fn(
    z.object({
      sessionID: SessionID.zod,
      title: z.string(),
    }),
    async (input) => {
      return Database.use((db) => {
        const now = Date.now()
        const row = db
          .query<
            SessionRow,
            [string, number, string]
          >("UPDATE session SET title = ?, time_updated = ? WHERE id = ? RETURNING *")
          .get(input.title, now, input.sessionID)
        if (!row) throw new NotFoundError({ message: `Session not found: ${input.sessionID}` })
        const info = fromRow(row)
        Database.effect(() => Bus.publish(Event.Updated, { info }))
        return info
      })
    },
  )

  export const setArchived = fn(
    z.object({
      sessionID: SessionID.zod,
      time: z.number().optional(),
    }),
    async (input) => {
      return Database.use((db) => {
        const now = Date.now()
        const row = db
          .query<
            SessionRow,
            [number | null, number, string]
          >("UPDATE session SET time_archived = ?, time_updated = ? WHERE id = ? RETURNING *")
          .get(input.time ?? null, now, input.sessionID)
        if (!row) throw new NotFoundError({ message: `Session not found: ${input.sessionID}` })
        const info = fromRow(row)
        Database.effect(() => Bus.publish(Event.Updated, { info }))
        return info
      })
    },
  )

  export const setPermission = fn(
    z.object({
      sessionID: SessionID.zod,
      permission: PermissionNext.Ruleset,
    }),
    async (input) => {
      return Database.use((db) => {
        const now = Date.now()
        const row = db
          .query<
            SessionRow,
            [string, number, string]
          >("UPDATE session SET permission = ?, time_updated = ? WHERE id = ? RETURNING *")
          .get(JSON.stringify(input.permission), now, input.sessionID)
        if (!row) throw new NotFoundError({ message: `Session not found: ${input.sessionID}` })
        const info = fromRow(row)
        Database.effect(() => Bus.publish(Event.Updated, { info }))
        return info
      })
    },
  )

  export const setRevert = fn(
    z.object({
      sessionID: SessionID.zod,
      revert: Info.shape.revert,
      summary: Info.shape.summary,
    }),
    async (input) => {
      return Database.use((db) => {
        const now = Date.now()
        const row = db
          .query<
            SessionRow,
            [string | null, number | null, number | null, number | null, number, string]
          >("UPDATE session SET revert = ?, summary_additions = ?, summary_deletions = ?, summary_files = ?, time_updated = ? WHERE id = ? RETURNING *")
          .get(
            input.revert ? JSON.stringify(input.revert) : null,
            input.summary?.additions ?? null,
            input.summary?.deletions ?? null,
            input.summary?.files ?? null,
            now,
            input.sessionID,
          )
        if (!row) throw new NotFoundError({ message: `Session not found: ${input.sessionID}` })
        const info = fromRow(row)
        Database.effect(() => Bus.publish(Event.Updated, { info }))
        return info
      })
    },
  )

  export const clearRevert = fn(SessionID.zod, async (sessionID) => {
    return Database.use((db) => {
      const now = Date.now()
      const row = db
        .query<
          SessionRow,
          [null, number, string]
        >("UPDATE session SET revert = ?, time_updated = ? WHERE id = ? RETURNING *")
        .get(null, now, sessionID)
      if (!row) throw new NotFoundError({ message: `Session not found: ${sessionID}` })
      const info = fromRow(row)
      Database.effect(() => Bus.publish(Event.Updated, { info }))
      return info
    })
  })

  export const setSummary = fn(
    z.object({
      sessionID: SessionID.zod,
      summary: Info.shape.summary,
    }),
    async (input) => {
      return Database.use((db) => {
        const now = Date.now()
        const row = db
          .query<
            SessionRow,
            [number | null, number | null, number | null, number, string]
          >("UPDATE session SET summary_additions = ?, summary_deletions = ?, summary_files = ?, time_updated = ? WHERE id = ? RETURNING *")
          .get(
            input.summary?.additions ?? null,
            input.summary?.deletions ?? null,
            input.summary?.files ?? null,
            now,
            input.sessionID,
          )
        if (!row) throw new NotFoundError({ message: `Session not found: ${input.sessionID}` })
        const info = fromRow(row)
        Database.effect(() => Bus.publish(Event.Updated, { info }))
        return info
      })
    },
  )

  export const diff = fn(SessionID.zod, async (sessionID) => {
    try {
      return SessionDiff.read(sessionID)
    } catch {
      return []
    }
  })

  export const messages = fn(
    z.object({
      sessionID: SessionID.zod,
      limit: z.number().optional(),
    }),
    async (input) => {
      const result = [] as MessageV2.WithParts[]
      for await (const msg of MessageV2.stream(input.sessionID)) {
        if (input.limit && result.length >= input.limit) break
        result.push(msg)
      }
      result.reverse()
      return result
    },
  )

  export function* list(input?: {
    directory?: string
    workspaceID?: WorkspaceID
    roots?: boolean
    start?: number
    search?: string
    limit?: number
  }) {
    const project = Instance.project
    const where: string[] = ["project_id = ?"]
    const params: any[] = [project.id]

    if (WorkspaceContext.workspaceID) {
      where.push("workspace_id = ?")
      params.push(WorkspaceContext.workspaceID)
    }
    if (input?.directory) {
      where.push("directory = ?")
      params.push(input.directory)
    }
    if (input?.roots) {
      where.push("parent_id IS NULL")
    }
    if (input?.start) {
      where.push("time_updated >= ?")
      params.push(input.start)
    }
    if (input?.search) {
      where.push("title LIKE ?")
      params.push(`%${input.search}%`)
    }

    const limit = input?.limit ?? 100

    const rows = Database.use((db) =>
      db
        .query<
          SessionRow,
          any[]
        >(`SELECT * FROM session WHERE ${where.join(" AND ")} ORDER BY time_updated DESC LIMIT ?`)
        .all(...params, limit),
    )
    for (const row of rows) {
      yield fromRow(row)
    }
  }

  export function* listGlobal(input?: {
    directory?: string
    roots?: boolean
    start?: number
    cursor?: number
    search?: string
    limit?: number
    archived?: boolean
  }) {
    const where: string[] = []
    const params: any[] = []

    if (input?.directory) {
      where.push("directory = ?")
      params.push(input.directory)
    }
    if (input?.roots) {
      where.push("parent_id IS NULL")
    }
    if (input?.start) {
      where.push("time_updated >= ?")
      params.push(input.start)
    }
    if (input?.cursor) {
      where.push("time_updated < ?")
      params.push(input.cursor)
    }
    if (input?.search) {
      where.push("title LIKE ?")
      params.push(`%${input.search}%`)
    }
    if (!input?.archived) {
      where.push("time_archived IS NULL")
    }

    const limit = input?.limit ?? 100

    const rows = Database.use((db) => {
      const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""
      return db
        .query<SessionRow, any[]>(`SELECT * FROM session ${clause} ORDER BY time_updated DESC, id DESC LIMIT ?`)
        .all(...params, limit)
    })

    const ids = [...new Set(rows.map((row) => row.project_id))]
    const projects = new Map<string, ProjectInfo>()

    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(", ")
      const items = Database.use((db) =>
        db
          .query<
            { id: string; name: string | null; worktree: string },
            any[]
          >(`SELECT id, name, worktree FROM project WHERE id IN (${placeholders})`)
          .all(...ids),
      )
      for (const item of items) {
        projects.set(item.id, {
          id: item.id,
          name: item.name ?? undefined,
          worktree: item.worktree,
        })
      }
    }

    for (const row of rows) {
      const project = projects.get(row.project_id) ?? null
      yield { ...fromRow(row), project }
    }
  }

  export const children = fn(SessionID.zod, async (parentID) => {
    const project = Instance.project
    const rows = Database.use((db) =>
      db
        .query<SessionRow, [string, string]>("SELECT * FROM session WHERE project_id = ? AND parent_id = ?")
        .all(project.id, parentID),
    )
    return rows.map(fromRow)
  })

  export const remove = fn(SessionID.zod, async (sessionID) => {
    const project = Instance.project
    try {
      const session = await get(sessionID)
      for (const child of await children(sessionID)) {
        await remove(child.id)
      }
      await unshare(sessionID).catch(() => {})
      // CASCADE delete handles messages and parts automatically
      Database.use((db) => {
        db.query("DELETE FROM session WHERE id = ?").run(sessionID)
        Database.effect(() =>
          Bus.publish(Event.Deleted, {
            info: session,
          }),
        )
      })
    } catch (e) {
      log.error(e)
    }
  })

  export const updateMessage = fn(MessageV2.Info, async (msg) => {
    const time = msg.time.created
    const { id, sessionID, ...data } = msg
    const json = JSON.stringify(data)
    const now = Date.now()
    Database.use((db) => {
      db.query(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = ?, time_updated = ?",
      ).run(id, sessionID, time, now, json, json, now)
      Database.effect(() =>
        Bus.publish(MessageV2.Event.Updated, {
          info: msg,
        }),
      )
    })
    return msg
  })

  export const removeMessage = fn(
    z.object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod,
    }),
    async (input) => {
      // CASCADE delete handles parts automatically
      Database.use((db) => {
        db.query("DELETE FROM message WHERE id = ? AND session_id = ?").run(input.messageID, input.sessionID)
        Database.effect(() =>
          Bus.publish(MessageV2.Event.Removed, {
            sessionID: input.sessionID,
            messageID: input.messageID,
          }),
        )
      })
      return input.messageID
    },
  )

  export const removePart = fn(
    z.object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod,
      partID: PartID.zod,
    }),
    async (input) => {
      Database.use((db) => {
        db.query("DELETE FROM part WHERE id = ? AND session_id = ?").run(input.partID, input.sessionID)
        Database.effect(() =>
          Bus.publish(MessageV2.Event.PartRemoved, {
            sessionID: input.sessionID,
            messageID: input.messageID,
            partID: input.partID,
          }),
        )
      })
      return input.partID
    },
  )

  const UpdatePartInput = MessageV2.Part

  export const updatePart = fn(UpdatePartInput, async (part) => {
    const { id, messageID, sessionID, ...data } = part
    const now = Date.now()
    const json = JSON.stringify(data)
    Database.use((db) => {
      db.query(
        "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = ?, time_updated = ?",
      ).run(id, messageID, sessionID, now, now, json, json, now)
      Database.effect(() =>
        Bus.publish(MessageV2.Event.PartUpdated, {
          part: structuredClone(part),
        }),
      )
    })
    return part
  })

  export const updatePartDelta = fn(
    z.object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod,
      partID: PartID.zod,
      field: z.string(),
      delta: z.string(),
    }),
    async (input) => {
      Bus.publish(MessageV2.Event.PartDelta, input)
    },
  )

  export const getUsage = fn(
    z.object({
      model: z.custom<Provider.Model>(),
      usage: z.custom<LanguageModelV2Usage>(),
      metadata: z.custom<ProviderMetadata>().optional(),
    }),
    (input) => {
      const safe = (value: number) => {
        if (!Number.isFinite(value)) return 0
        return value
      }
      const inputTokens = safe(input.usage.inputTokens ?? 0)
      const outputTokens = safe(input.usage.outputTokens ?? 0)
      const reasoningTokens = safe(input.usage.reasoningTokens ?? 0)

      const cacheReadInputTokens = safe(input.usage.cachedInputTokens ?? 0)
      const cacheWriteInputTokens = safe(
        (input.metadata?.["anthropic"]?.["cacheCreationInputTokens"] ??
          // @ts-expect-error
          input.metadata?.["bedrock"]?.["usage"]?.["cacheWriteInputTokens"] ??
          // @ts-expect-error
          input.metadata?.["venice"]?.["usage"]?.["cacheCreationInputTokens"] ??
          0) as number,
      )

      // OpenRouter provides inputTokens as the total count of input tokens (including cached).
      // AFAIK other providers (OpenRouter/OpenAI/Gemini etc.) do it the same way e.g. vercel/ai#8794 (comment)
      // Anthropic does it differently though - inputTokens doesn't include cached tokens.
      // It looks like OpenCode's cost calculation assumes all providers return inputTokens the same way Anthropic does (I'm guessing getUsage logic was originally implemented with anthropic), so it's causing incorrect cost calculation for OpenRouter and others.
      const excludesCachedTokens = !!(input.metadata?.["anthropic"] || input.metadata?.["bedrock"])
      const adjustedInputTokens = safe(
        excludesCachedTokens ? inputTokens : inputTokens - cacheReadInputTokens - cacheWriteInputTokens,
      )

      const total = iife(() => {
        // Anthropic doesn't provide total_tokens, also ai sdk will vastly undercount if we
        // don't compute from components
        if (
          input.model.api.npm === "@ai-sdk/anthropic" ||
          input.model.api.npm === "@ai-sdk/amazon-bedrock" ||
          input.model.api.npm === "@ai-sdk/google-vertex/anthropic"
        ) {
          return adjustedInputTokens + outputTokens + cacheReadInputTokens + cacheWriteInputTokens
        }
        return input.usage.totalTokens
      })

      const tokens = {
        total,
        input: adjustedInputTokens,
        output: outputTokens,
        reasoning: reasoningTokens,
        cache: {
          write: cacheWriteInputTokens,
          read: cacheReadInputTokens,
        },
      }

      const costInfo =
        input.model.cost?.experimentalOver200K && tokens.input + tokens.cache.read > 200_000
          ? input.model.cost.experimentalOver200K
          : input.model.cost
      return {
        cost: safe(
          new Decimal(0)
            .add(new Decimal(tokens.input).mul(costInfo?.input ?? 0).div(1_000_000))
            .add(new Decimal(tokens.output).mul(costInfo?.output ?? 0).div(1_000_000))
            .add(new Decimal(tokens.cache.read).mul(costInfo?.cache?.read ?? 0).div(1_000_000))
            .add(new Decimal(tokens.cache.write).mul(costInfo?.cache?.write ?? 0).div(1_000_000))
            // TODO: update models.dev to have better pricing model, for now:
            // charge reasoning tokens at the same rate as output tokens
            .add(new Decimal(tokens.reasoning).mul(costInfo?.output ?? 0).div(1_000_000))
            .toNumber(),
        ),
        tokens,
      }
    },
  )

  export class BusyError extends Error {
    constructor(public readonly sessionID: string) {
      super(`Session ${sessionID} is busy`)
    }
  }

  export const initialize = fn(
    z.object({
      sessionID: SessionID.zod,
      modelID: ModelID.zod,
      providerID: ProviderID.zod,
      messageID: MessageID.zod,
    }),
    async (input) => {
      await SessionPrompt.command({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: input.providerID + "/" + input.modelID,
        command: Command.Default.INIT,
        arguments: "",
      })
    },
  )
}
