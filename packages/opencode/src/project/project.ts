import z from "zod"
import { Filesystem } from "../util/filesystem"
import path from "path"
import { Database } from "../storage/db"
import type { ProjectRow } from "./project.sql"
import { Log } from "../util/log"
import { Flag } from "@/flag/flag"
import { fn } from "@opencode-ai/util/fn"
import { BusEvent } from "@/bus/bus-event"
import { iife } from "@/util/iife"
import { GlobalBus } from "@/bus/global"
import { existsSync } from "fs"
import { git } from "../util/git"
import { Glob } from "../util/glob"
import { which } from "../util/which"
import { ProjectID } from "./schema"

export namespace Project {
  const log = Log.create({ service: "project" })

  function gitpath(cwd: string, name: string) {
    if (!name) return cwd
    // git output includes trailing newlines; keep path whitespace intact.
    name = name.replace(/[\r\n]+$/, "")
    if (!name) return cwd

    name = Filesystem.windowsPath(name)

    if (path.isAbsolute(name)) return path.normalize(name)
    return path.resolve(cwd, name)
  }

  export const Info = z
    .object({
      id: ProjectID.zod,
      worktree: z.string(),
      vcs: z.literal("git").optional(),
      name: z.string().optional(),
      icon: z
        .object({
          url: z.string().optional(),
          override: z.string().optional(),
          color: z.string().optional(),
        })
        .optional(),
      commands: z
        .object({
          start: z.string().optional().describe("Startup script to run when creating a new workspace (worktree)"),
        })
        .optional(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        initialized: z.number().optional(),
      }),
      sandboxes: z.array(z.string()),
    })
    .meta({
      ref: "Project",
    })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define("project.updated", Info),
  }

  type Row = ProjectRow

  function parse(row: Row): Row {
    return {
      ...row,
      sandboxes: typeof row.sandboxes === "string" ? JSON.parse(row.sandboxes) : row.sandboxes,
      commands: typeof row.commands === "string" ? JSON.parse(row.commands) : row.commands,
    }
  }

  export function fromRow(row: Row): Info {
    const parsed = parse(row)
    const icon =
      parsed.icon_url || parsed.icon_color
        ? { url: parsed.icon_url ?? undefined, color: parsed.icon_color ?? undefined }
        : undefined
    return {
      id: ProjectID.make(parsed.id),
      worktree: parsed.worktree,
      vcs: parsed.vcs ? Info.shape.vcs.parse(parsed.vcs) : undefined,
      name: parsed.name ?? undefined,
      icon,
      time: {
        created: parsed.time_created,
        updated: parsed.time_updated,
        initialized: parsed.time_initialized ?? undefined,
      },
      sandboxes: parsed.sandboxes,
      commands: parsed.commands ?? undefined,
    }
  }

  function readCachedId(dir: string) {
    return Filesystem.readText(path.join(dir, "opencode"))
      .then((x) => x.trim())
      .then(ProjectID.make)
      .catch(() => undefined)
  }

  export async function fromDirectory(directory: string) {
    log.info("fromDirectory", { directory })

    const data = await iife(async () => {
      const matches = Filesystem.up({ targets: [".git"], start: directory })
      const dotgit = await matches.next().then((x) => x.value)
      await matches.return()
      if (dotgit) {
        let sandbox = path.dirname(dotgit)

        const gitBinary = which("git")

        // cached id calculation
        let id = await readCachedId(dotgit)

        if (!gitBinary) {
          return {
            id: id ?? ProjectID.global,
            worktree: sandbox,
            sandbox,
            vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS),
          }
        }

        const worktree = await git(["rev-parse", "--git-common-dir"], {
          cwd: sandbox,
        })
          .then(async (result) => {
            const common = gitpath(sandbox, await result.text())
            // Avoid going to parent of sandbox when git-common-dir is empty.
            return common === sandbox ? sandbox : path.dirname(common)
          })
          .catch(() => undefined)

        if (!worktree) {
          return {
            id: id ?? ProjectID.global,
            worktree: sandbox,
            sandbox,
            vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS),
          }
        }

        // In the case of a git worktree, it can't cache the id
        // because `.git` is not a folder, but it always needs the
        // same project id as the common dir, so we resolve it now
        if (id == null) {
          id = await readCachedId(path.join(worktree, ".git"))
        }

        // generate id from root commit
        if (!id) {
          const roots = await git(["rev-list", "--max-parents=0", "HEAD"], {
            cwd: sandbox,
          })
            .then(async (result) =>
              (await result.text())
                .split("\n")
                .filter(Boolean)
                .map((x) => x.trim())
                .toSorted(),
            )
            .catch(() => undefined)

          if (!roots) {
            return {
              id: ProjectID.global,
              worktree: sandbox,
              sandbox,
              vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS),
            }
          }

          id = roots[0] ? ProjectID.make(roots[0]) : undefined
          if (id) {
            // Write to common dir so the cache is shared across worktrees.
            await Filesystem.write(path.join(worktree, ".git", "opencode"), id).catch(() => undefined)
          }
        }

        if (!id) {
          return {
            id: ProjectID.global,
            worktree: sandbox,
            sandbox,
            vcs: "git",
          }
        }

        const top = await git(["rev-parse", "--show-toplevel"], {
          cwd: sandbox,
        })
          .then(async (result) => gitpath(sandbox, await result.text()))
          .catch(() => undefined)

        if (!top) {
          return {
            id,
            worktree: sandbox,
            sandbox,
            vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS),
          }
        }

        sandbox = top

        return {
          id,
          sandbox,
          worktree,
          vcs: "git",
        }
      }

      return {
        id: ProjectID.global,
        worktree: "/",
        sandbox: "/",
        vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS),
      }
    })

    const row = Database.use((db) => db.query<ProjectRow, [string]>("SELECT * FROM project WHERE id = ?").get(data.id))
    const existing = row
      ? fromRow(row)
      : {
          id: data.id,
          worktree: data.worktree,
          vcs: data.vcs as Info["vcs"],
          sandboxes: [] as string[],
          time: {
            created: Date.now(),
            updated: Date.now(),
          },
        }

    if (Flag.OPENCODE_EXPERIMENTAL_ICON_DISCOVERY) discover(existing)

    const result: Info = {
      ...existing,
      worktree: data.worktree,
      vcs: data.vcs as Info["vcs"],
      time: {
        ...existing.time,
        updated: Date.now(),
      },
    }
    if (data.sandbox !== result.worktree && !result.sandboxes.includes(data.sandbox))
      result.sandboxes.push(data.sandbox)
    result.sandboxes = result.sandboxes.filter((x) => existsSync(x))
    const now = Date.now()
    Database.use((db) =>
      db
        .query(
          `INSERT INTO project (id, worktree, vcs, name, icon_url, icon_color, time_created, time_updated, time_initialized, sandboxes, commands)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             worktree = excluded.worktree,
             vcs = excluded.vcs,
             name = excluded.name,
             icon_url = excluded.icon_url,
             icon_color = excluded.icon_color,
             time_updated = excluded.time_updated,
             time_initialized = excluded.time_initialized,
             sandboxes = excluded.sandboxes,
             commands = excluded.commands`,
        )
        .run(
          result.id,
          result.worktree,
          result.vcs ?? null,
          result.name ?? null,
          result.icon?.url ?? null,
          result.icon?.color ?? null,
          result.time.created,
          now,
          result.time.initialized ?? null,
          JSON.stringify(result.sandboxes),
          result.commands ? JSON.stringify(result.commands) : null,
        ),
    )
    // Runs after upsert so the target project row exists (FK constraint).
    // Runs on every startup because sessions created before git init
    // accumulate under "global" and need migrating whenever they appear.
    if (data.id !== ProjectID.global) {
      Database.use((db) =>
        db
          .query("UPDATE session SET project_id = ? WHERE project_id = ? AND directory = ?")
          .run(data.id, ProjectID.global, data.worktree),
      )
    }
    GlobalBus.emit("event", {
      payload: {
        type: Event.Updated.type,
        properties: result,
      },
    })
    return { project: result, sandbox: data.sandbox }
  }

  export async function discover(input: Info) {
    if (input.vcs !== "git") return
    if (input.icon?.override) return
    if (input.icon?.url) return
    const matches = await Glob.scan("**/favicon.{ico,png,svg,jpg,jpeg,webp}", {
      cwd: input.worktree,
      absolute: true,
      include: "file",
    })
    const shortest = matches.sort((a, b) => a.length - b.length)[0]
    if (!shortest) return
    const buffer = await Filesystem.readBytes(shortest)
    const base64 = buffer.toString("base64")
    const mime = Filesystem.mimeType(shortest) || "image/png"
    const url = `data:${mime};base64,${base64}`
    await update({
      projectID: input.id,
      icon: {
        url,
      },
    })
    return
  }

  export function setInitialized(id: ProjectID) {
    Database.use((db) => db.query("UPDATE project SET time_initialized = ? WHERE id = ?").run(Date.now(), id))
  }

  export function list() {
    return Database.use((db) =>
      db
        .query<ProjectRow, []>("SELECT * FROM project")
        .all()
        .map((row) => fromRow(row)),
    )
  }

  export function get(id: ProjectID): Info | undefined {
    const row = Database.use((db) => db.query<ProjectRow, [string]>("SELECT * FROM project WHERE id = ?").get(id))
    if (!row) return undefined
    return fromRow(row)
  }

  export async function initGit(input: { directory: string; project: Info }) {
    if (input.project.vcs === "git") return input.project
    if (!which("git")) throw new Error("Git is not installed")

    const result = await git(["init", "--quiet"], {
      cwd: input.directory,
    })
    if (result.exitCode !== 0) {
      const text = result.stderr.toString().trim() || result.text().trim()
      throw new Error(text || "Failed to initialize git repository")
    }

    return (await fromDirectory(input.directory)).project
  }

  export const update = fn(
    z.object({
      projectID: ProjectID.zod,
      name: z.string().optional(),
      icon: Info.shape.icon.optional(),
      commands: Info.shape.commands.optional(),
    }),
    async (input) => {
      const id = ProjectID.make(input.projectID)
      const sets: string[] = ["time_updated = ?"]
      const vals: any[] = [Date.now()]
      if (input.name !== undefined) {
        sets.push("name = ?")
        vals.push(input.name)
      }
      if (input.icon?.url !== undefined) {
        sets.push("icon_url = ?")
        vals.push(input.icon.url)
      }
      if (input.icon?.color !== undefined) {
        sets.push("icon_color = ?")
        vals.push(input.icon.color)
      }
      if (input.commands !== undefined) {
        sets.push("commands = ?")
        vals.push(input.commands ? JSON.stringify(input.commands) : null)
      }
      vals.push(id)
      const result = Database.use((db) =>
        db.query<ProjectRow, any[]>(`UPDATE project SET ${sets.join(", ")} WHERE id = ? RETURNING *`).get(...vals),
      )
      if (!result) throw new Error(`Project not found: ${input.projectID}`)
      const data = fromRow(result)
      GlobalBus.emit("event", {
        payload: {
          type: Event.Updated.type,
          properties: data,
        },
      })
      return data
    },
  )

  export async function sandboxes(id: ProjectID) {
    const row = Database.use((db) => db.query<ProjectRow, [string]>("SELECT * FROM project WHERE id = ?").get(id))
    if (!row) return []
    const data = fromRow(row)
    const valid: string[] = []
    for (const dir of data.sandboxes) {
      const s = Filesystem.stat(dir)
      if (s?.isDirectory()) valid.push(dir)
    }
    return valid
  }

  export async function addSandbox(id: ProjectID, directory: string) {
    const row = Database.use((db) => db.query<ProjectRow, [string]>("SELECT * FROM project WHERE id = ?").get(id))
    if (!row) throw new Error(`Project not found: ${id}`)
    const parsed = parse(row)
    const sbx = [...parsed.sandboxes]
    if (!sbx.includes(directory)) sbx.push(directory)
    const result = Database.use((db) =>
      db
        .query<
          ProjectRow,
          [string, number, string]
        >("UPDATE project SET sandboxes = ?, time_updated = ? WHERE id = ? RETURNING *")
        .get(JSON.stringify(sbx), Date.now(), id),
    )
    if (!result) throw new Error(`Project not found: ${id}`)
    const data = fromRow(result)
    GlobalBus.emit("event", {
      payload: {
        type: Event.Updated.type,
        properties: data,
      },
    })
    return data
  }

  export async function removeSandbox(id: ProjectID, directory: string) {
    const row = Database.use((db) => db.query<ProjectRow, [string]>("SELECT * FROM project WHERE id = ?").get(id))
    if (!row) throw new Error(`Project not found: ${id}`)
    const parsed = parse(row)
    const sbx = parsed.sandboxes.filter((s) => s !== directory)
    const result = Database.use((db) =>
      db
        .query<
          ProjectRow,
          [string, number, string]
        >("UPDATE project SET sandboxes = ?, time_updated = ? WHERE id = ? RETURNING *")
        .get(JSON.stringify(sbx), Date.now(), id),
    )
    if (!result) throw new Error(`Project not found: ${id}`)
    const data = fromRow(result)
    GlobalBus.emit("event", {
      payload: {
        type: Event.Updated.type,
        properties: data,
      },
    })
    return data
  }
}
