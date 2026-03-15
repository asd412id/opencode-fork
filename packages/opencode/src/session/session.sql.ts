import type { MessageV2 } from "./message-v2"
import type { Snapshot } from "../snapshot"
import type { PermissionNext } from "../permission/next"
import type { ProjectID } from "../project/schema"
import type { SessionID, MessageID, PartID } from "./schema"
import type { WorkspaceID } from "../control-plane/schema"

type PartData = Omit<MessageV2.Part, "id" | "sessionID" | "messageID">
type InfoData = Omit<MessageV2.Info, "id" | "sessionID">

export type SessionRow = {
  id: SessionID
  project_id: ProjectID
  workspace_id: WorkspaceID | null
  parent_id: SessionID | null
  slug: string
  directory: string
  title: string
  version: string
  share_url: string | null
  summary_additions: number | null
  summary_deletions: number | null
  summary_files: number | null
  summary_diffs: Snapshot.FileDiff[] | null
  revert: { messageID: MessageID; partID?: PartID; snapshot?: string; diff?: string } | null
  permission: PermissionNext.Ruleset | null
  time_created: number
  time_updated: number
  time_compacting: number | null
  time_archived: number | null
}

export type MessageRow = {
  id: MessageID
  session_id: SessionID
  time_created: number
  time_updated: number
  data: InfoData
}

export type PartRow = {
  id: PartID
  message_id: MessageID
  session_id: SessionID
  time_created: number
  time_updated: number
  data: PartData
}

export type TodoRow = {
  session_id: SessionID
  content: string
  status: string
  priority: string
  position: number
  time_created: number
  time_updated: number
}

export type PermissionRow = {
  project_id: string
  time_created: number
  time_updated: number
  data: PermissionNext.Ruleset
}
