import { Database } from "../storage/db"
import type { SessionID } from "./schema"
import type { Snapshot } from "../snapshot"

export namespace SessionDiff {
  type Row = { session_id: string; data: string; time_created: number; time_updated: number }

  export function read(id: SessionID): Snapshot.FileDiff[] {
    const row = Database.sqlite().query<Row, [string]>("SELECT data FROM session_diff WHERE session_id = ?").get(id)
    if (!row) return []
    return JSON.parse(row.data)
  }

  export function write(id: SessionID, data: Snapshot.FileDiff[]) {
    const now = Date.now()
    const json = JSON.stringify(data)
    Database.sqlite()
      .query(
        `INSERT INTO session_diff (session_id, data, time_created, time_updated)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET data = excluded.data, time_updated = excluded.time_updated`,
      )
      .run(id, json, now, now)
  }
}
