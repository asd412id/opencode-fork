import type { ProjectID } from "../project/schema"
import type { WorkspaceID } from "./schema"

export type WorkspaceRow = {
  id: WorkspaceID
  type: string
  branch: string | null
  name: string | null
  directory: string | null
  extra: unknown | null
  project_id: ProjectID
}
