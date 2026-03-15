import type { AccessToken, AccountID, OrgID, RefreshToken } from "./schema"

export type AccountRow = {
  id: AccountID
  email: string
  url: string
  access_token: AccessToken
  refresh_token: RefreshToken
  token_expiry: number | null
  time_created: number
  time_updated: number
}

export type AccountStateRow = {
  id: number
  active_account_id: AccountID | null
  active_org_id: OrgID | null
}

// LEGACY
export type ControlAccountRow = {
  email: string
  url: string
  access_token: AccessToken
  refresh_token: RefreshToken
  token_expiry: number | null
  active: number
  time_created: number
  time_updated: number
}
