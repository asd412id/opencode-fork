import { Effect, Layer, Option, Schema, ServiceMap } from "effect"

import { Database } from "@/storage/db"
import type { AccountRow, AccountStateRow } from "./account.sql"
import { AccessToken, Account, AccountID, AccountRepoError, OrgID, RefreshToken } from "./schema"

export type { AccountRow }

type Db = Parameters<typeof Database.use>[0] extends (db: infer T) => unknown ? T : never

const ACCOUNT_STATE_ID = 1

export namespace AccountRepo {
  export interface Service {
    readonly active: () => Effect.Effect<Option.Option<Account>, AccountRepoError>
    readonly list: () => Effect.Effect<Account[], AccountRepoError>
    readonly remove: (accountID: AccountID) => Effect.Effect<void, AccountRepoError>
    readonly use: (accountID: AccountID, orgID: Option.Option<OrgID>) => Effect.Effect<void, AccountRepoError>
    readonly getRow: (accountID: AccountID) => Effect.Effect<Option.Option<AccountRow>, AccountRepoError>
    readonly persistToken: (input: {
      accountID: AccountID
      accessToken: AccessToken
      refreshToken: RefreshToken
      expiry: Option.Option<number>
    }) => Effect.Effect<void, AccountRepoError>
    readonly persistAccount: (input: {
      id: AccountID
      email: string
      url: string
      accessToken: AccessToken
      refreshToken: RefreshToken
      expiry: number
      orgID: Option.Option<OrgID>
    }) => Effect.Effect<void, AccountRepoError>
  }
}

export class AccountRepo extends ServiceMap.Service<AccountRepo, AccountRepo.Service>()("@opencode/AccountRepo") {
  static readonly layer: Layer.Layer<AccountRepo> = Layer.effect(
    AccountRepo,
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownSync(Account)

      const query = <A>(f: (db: Db) => A) =>
        Effect.try({
          try: () => Database.use(f),
          catch: (cause) => new AccountRepoError({ message: "Database operation failed", cause }),
        })

      const tx = <A>(f: (db: Db) => A) =>
        Effect.try({
          try: () => Database.transaction(f),
          catch: (cause) => new AccountRepoError({ message: "Database operation failed", cause }),
        })

      const current = (db: Db) => {
        const state = db
          .query<AccountStateRow, [number]>("SELECT * FROM account_state WHERE id = ?")
          .get(ACCOUNT_STATE_ID)
        if (!state?.active_account_id) return
        const account = db
          .query<AccountRow, [string]>("SELECT * FROM account WHERE id = ?")
          .get(state.active_account_id)
        if (!account) return
        return { ...account, active_org_id: state.active_org_id ?? null }
      }

      const state = (db: Db, accountID: AccountID, orgID: Option.Option<OrgID>) => {
        const org = Option.getOrNull(orgID)
        return db
          .query(
            "INSERT INTO account_state (id, active_account_id, active_org_id) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET active_account_id = ?, active_org_id = ?",
          )
          .run(ACCOUNT_STATE_ID, accountID, org, accountID, org)
      }

      const active = Effect.fn("AccountRepo.active")(() =>
        query((db) => current(db)).pipe(Effect.map((row) => (row ? Option.some(decode(row)) : Option.none()))),
      )

      const list = Effect.fn("AccountRepo.list")(() =>
        query((db) =>
          db
            .query<AccountRow, []>("SELECT * FROM account")
            .all()
            .map((row) => decode({ ...row, active_org_id: null })),
        ),
      )

      const remove = Effect.fn("AccountRepo.remove")((accountID: AccountID) =>
        tx((db) => {
          db.query(
            "UPDATE account_state SET active_account_id = NULL, active_org_id = NULL WHERE active_account_id = ?",
          ).run(accountID)
          db.query("DELETE FROM account WHERE id = ?").run(accountID)
        }).pipe(Effect.asVoid),
      )

      const use = Effect.fn("AccountRepo.use")((accountID: AccountID, orgID: Option.Option<OrgID>) =>
        query((db) => state(db, accountID, orgID)).pipe(Effect.asVoid),
      )

      const getRow = Effect.fn("AccountRepo.getRow")((accountID: AccountID) =>
        query((db) => db.query<AccountRow, [string]>("SELECT * FROM account WHERE id = ?").get(accountID)).pipe(
          Effect.map(Option.fromNullishOr),
        ),
      )

      const persistToken = Effect.fn("AccountRepo.persistToken")((input) =>
        query((db) => {
          const now = Date.now()
          db.query(
            "UPDATE account SET access_token = ?, refresh_token = ?, token_expiry = ?, time_updated = ? WHERE id = ?",
          ).run(input.accessToken, input.refreshToken, Option.getOrNull(input.expiry), now, input.accountID)
        }).pipe(Effect.asVoid),
      )

      const persistAccount = Effect.fn("AccountRepo.persistAccount")((input) =>
        tx((db) => {
          const now = Date.now()
          db.query(
            "INSERT INTO account (id, email, url, access_token, refresh_token, token_expiry, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET access_token = ?, refresh_token = ?, token_expiry = ?, time_updated = ?",
          ).run(
            input.id,
            input.email,
            input.url,
            input.accessToken,
            input.refreshToken,
            input.expiry,
            now,
            now,
            input.accessToken,
            input.refreshToken,
            input.expiry,
            now,
          )
          void state(db, input.id, input.orgID)
        }).pipe(Effect.asVoid),
      )

      return AccountRepo.of({
        active,
        list,
        remove,
        use,
        getRow,
        persistToken,
        persistAccount,
      })
    }),
  )
}
