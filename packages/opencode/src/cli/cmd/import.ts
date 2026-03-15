import type { Argv } from "yargs"
import type { Session as SDKSession, Message, Part } from "@opencode-ai/sdk/v2"
import { Session } from "../../session"
import { MessageV2 } from "../../session/message-v2"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { Database } from "../../storage/db"
import type { SessionRow } from "../../session/session.sql"
import { Instance } from "../../project/instance"
import { ShareNext } from "../../share/share-next"
import { EOL } from "os"
import { Filesystem } from "../../util/filesystem"

/** Discriminated union returned by the ShareNext API (GET /api/shares/:id/data) */
export type ShareData =
  | { type: "session"; data: SDKSession }
  | { type: "message"; data: Message }
  | { type: "part"; data: Part }
  | { type: "session_diff"; data: unknown }
  | { type: "model"; data: unknown }

/** Extract share ID from a share URL like https://opncd.ai/share/abc123 */
export function parseShareUrl(url: string): string | null {
  const match = url.match(/^https?:\/\/[^/]+\/share\/([a-zA-Z0-9_-]+)$/)
  return match ? match[1] : null
}

export function shouldAttachShareAuthHeaders(shareUrl: string, accountBaseUrl: string): boolean {
  try {
    return new URL(shareUrl).origin === new URL(accountBaseUrl).origin
  } catch {
    return false
  }
}

/**
 * Transform ShareNext API response (flat array) into the nested structure for local file storage.
 *
 * The API returns a flat array: [session, message, message, part, part, ...]
 * Local storage expects: { info: session, messages: [{ info: message, parts: [part, ...] }, ...] }
 *
 * This groups parts by their messageID to reconstruct the hierarchy before writing to disk.
 */
export function transformShareData(shareData: ShareData[]): {
  info: SDKSession
  messages: Array<{ info: Message; parts: Part[] }>
} | null {
  const sessionItem = shareData.find((d) => d.type === "session")
  if (!sessionItem) return null

  const messageMap = new Map<string, Message>()
  const partMap = new Map<string, Part[]>()

  for (const item of shareData) {
    if (item.type === "message") {
      messageMap.set(item.data.id, item.data)
    } else if (item.type === "part") {
      if (!partMap.has(item.data.messageID)) {
        partMap.set(item.data.messageID, [])
      }
      partMap.get(item.data.messageID)!.push(item.data)
    }
  }

  if (messageMap.size === 0) return null

  return {
    info: sessionItem.data,
    messages: Array.from(messageMap.values()).map((msg) => ({
      info: msg,
      parts: partMap.get(msg.id) ?? [],
    })),
  }
}

export const ImportCommand = cmd({
  command: "import <file>",
  describe: "import session data from JSON file or URL",
  builder: (yargs: Argv) => {
    return yargs.positional("file", {
      describe: "path to JSON file or share URL",
      type: "string",
      demandOption: true,
    })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      let exportData:
        | {
            info: SDKSession
            messages: Array<{
              info: Message
              parts: Part[]
            }>
          }
        | undefined

      const isUrl = args.file.startsWith("http://") || args.file.startsWith("https://")

      if (isUrl) {
        const slug = parseShareUrl(args.file)
        if (!slug) {
          const baseUrl = await ShareNext.url()
          process.stdout.write(`Invalid URL format. Expected: ${baseUrl}/share/<slug>`)
          process.stdout.write(EOL)
          return
        }

        const parsed = new URL(args.file)
        const baseUrl = parsed.origin
        const req = await ShareNext.request()
        const headers = shouldAttachShareAuthHeaders(args.file, req.baseUrl) ? req.headers : {}

        const dataPath = req.api.data(slug)
        let response = await fetch(`${baseUrl}${dataPath}`, {
          headers,
        })

        if (!response.ok && dataPath !== `/api/share/${slug}/data`) {
          response = await fetch(`${baseUrl}/api/share/${slug}/data`, {
            headers,
          })
        }

        if (!response.ok) {
          process.stdout.write(`Failed to fetch share data: ${response.statusText}`)
          process.stdout.write(EOL)
          return
        }

        const shareData: ShareData[] = await response.json()
        const transformed = transformShareData(shareData)

        if (!transformed) {
          process.stdout.write(`Share not found or empty: ${slug}`)
          process.stdout.write(EOL)
          return
        }

        exportData = transformed
      } else {
        exportData = await Filesystem.readJson<NonNullable<typeof exportData>>(args.file).catch(() => undefined)
        if (!exportData) {
          process.stdout.write(`File not found: ${args.file}`)
          process.stdout.write(EOL)
          return
        }
      }

      if (!exportData) {
        process.stdout.write(`Failed to read session data`)
        process.stdout.write(EOL)
        return
      }

      const info = Session.Info.parse({
        ...exportData.info,
        projectID: Instance.project.id,
      })
      const row = Session.toRow(info)
      const now = Date.now()
      Database.use((db) =>
        db
          .query(
            `INSERT INTO session (id, project_id, workspace_id, parent_id, slug, directory, title, version, share_url, summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission, time_created, time_updated, time_compacting, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id = ?`,
          )
          .run(
            row.id,
            row.project_id,
            (row as any).workspace_id ?? null,
            row.parent_id ?? null,
            row.slug,
            row.directory,
            row.title,
            row.version,
            row.share_url ?? null,
            row.summary_additions ?? null,
            row.summary_deletions ?? null,
            row.summary_files ?? null,
            row.summary_diffs ? JSON.stringify(row.summary_diffs) : null,
            row.revert ? JSON.stringify(row.revert) : null,
            row.permission ? JSON.stringify(row.permission) : null,
            row.time_created,
            row.time_updated,
            row.time_compacting ?? null,
            row.time_archived ?? null,
            row.project_id,
          ),
      )

      for (const msg of exportData.messages) {
        const msgInfo = MessageV2.Info.parse(msg.info)
        const { id, sessionID: _, ...msgData } = msgInfo
        Database.use((db) =>
          db
            .query(
              "INSERT OR IGNORE INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            )
            .run(id, row.id, msgInfo.time?.created ?? now, msgInfo.time?.created ?? now, JSON.stringify(msgData)),
        )

        for (const part of msg.parts) {
          const partInfo = MessageV2.Part.parse(part)
          const { id: partId, sessionID: _s, messageID, ...partData } = partInfo
          Database.use((db) =>
            db
              .query(
                "INSERT OR IGNORE INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
              )
              .run(partId, messageID, row.id, now, now, JSON.stringify(partData)),
          )
        }
      }

      process.stdout.write(`Imported session: ${exportData.info.id}`)
      process.stdout.write(EOL)
    })
  },
})
