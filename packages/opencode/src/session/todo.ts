import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { SessionID } from "./schema"
import z from "zod"
import { Database } from "../storage/db"
import type { TodoRow } from "./session.sql"

export namespace Todo {
  export const Info = z
    .object({
      content: z.string().describe("Brief description of the task"),
      status: z.string().describe("Current status of the task: pending, in_progress, completed, cancelled"),
      priority: z.string().describe("Priority level of the task: high, medium, low"),
    })
    .meta({ ref: "Todo" })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define(
      "todo.updated",
      z.object({
        sessionID: SessionID.zod,
        todos: z.array(Info),
      }),
    ),
  }

  export function update(input: { sessionID: SessionID; todos: Info[] }) {
    const now = Date.now()
    Database.transaction((db) => {
      db.query("DELETE FROM todo WHERE session_id = ?").run(input.sessionID)
      if (input.todos.length === 0) return
      const stmt = db.query(
        "INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      for (let i = 0; i < input.todos.length; i++) {
        const todo = input.todos[i]
        stmt.run(input.sessionID, todo.content, todo.status, todo.priority, i, now, now)
      }
    })
    Bus.publish(Event.Updated, input)
  }

  export function get(sessionID: SessionID) {
    const rows = Database.use((db) =>
      db.query<TodoRow, [string]>("SELECT * FROM todo WHERE session_id = ? ORDER BY position ASC").all(sessionID),
    )
    return rows.map((row) => ({
      content: row.content,
      status: row.status,
      priority: row.priority,
    }))
  }
}
