import type { ProjectID } from "./schema"

export type ProjectRow = {
  id: ProjectID
  worktree: string
  vcs: string | null
  name: string | null
  icon_url: string | null
  icon_color: string | null
  time_created: number
  time_updated: number
  time_initialized: number | null
  sandboxes: string[]
  commands: { start?: string } | null
}
