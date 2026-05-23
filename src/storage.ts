import { Database } from "bun:sqlite"
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import z from "zod"

const LimitWindow = z.object({
  usedPercent: z.number().nonnegative(),
  windowMinutes: z.number().int().nonnegative().optional(),
  resetsAt: z.number().int().nonnegative().optional(),
})

const LimitSnapshot = z.object({
  capturedAt: z.number().int().nonnegative(),
  limitName: z.string().optional(),
  primary: LimitWindow.optional(),
  secondary: LimitWindow.optional(),
})

const AccountSchema = z.object({
  label: z.string(),
  email: z.string().optional(),
  planType: z.string().optional(),
  userId: z.string().optional(),
  refreshToken: z.string(),
  accessToken: z.string(),
  tokenExpires: z.number().int().nonnegative(),
  accountId: z.string().optional(),
  addedAt: z.number().int().nonnegative(),
  lastUsed: z.number().int().nonnegative(),
  enabled: z.boolean(),
  activeLimitId: z.string().default("codex"),
  limits: z.record(z.string(), LimitSnapshot).default({}),
  rateLimitResetTime: z.number().int().nonnegative().optional(),
})

const StoreSchema = z.object({
  version: z.literal(1),
  activeIndex: z.number().int().nonnegative(),
  accounts: z.array(AccountSchema),
})

const RefreshLockSchema = z.object({
  owner: z.string(),
  expiresAt: z.number().int().nonnegative(),
})

const REFRESH_LOCK_KEY = "refresh_lock"

type AccountRow = {
  id: number
  label: string
  email: string | null
  plan_type: string | null
  user_id: string | null
  refresh_token: string
  access_token: string
  token_expires: number
  account_id: string | null
  added_at: number
  last_used: number
  enabled: number
  active_limit_id: string
  limits_json: string
  rate_limit_reset_time: number | null
  position: number
}

type MetaRow = {
  value: string
}

export type Account = z.infer<typeof AccountSchema>
export type ManagedAccount = Account & { storageId?: number }
export type Store = z.infer<typeof StoreSchema>
export type ManagedStore = {
  version: 1
  activeIndex: number
  accounts: ManagedAccount[]
}

export type RefreshLock = z.infer<typeof RefreshLockSchema>

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function clampActiveIndex(index: number, count: number) {
  if (count === 0) return 0
  return Math.max(0, Math.min(index, count - 1))
}

function normalizeAccount(account: ManagedAccount) {
  const storageId = typeof account.storageId === "number" && Number.isInteger(account.storageId) && account.storageId > 0
    ? account.storageId
    : undefined
  const parsed = AccountSchema.parse(account)
  return storageId ? { ...parsed, storageId } : parsed
}

function normalizeStore(store: Store | ManagedStore): ManagedStore {
  const accounts = store.accounts.map((account) => normalizeAccount(account as ManagedAccount))
  return {
    version: 1,
    activeIndex: clampActiveIndex(store.activeIndex, accounts.length),
    accounts,
  }
}

function stripStore(store: ManagedStore): Store {
  return {
    version: 1,
    activeIndex: clampActiveIndex(store.activeIndex, store.accounts.length),
    accounts: store.accounts.map((account) => AccountSchema.parse(account)),
  }
}

function rowToAccount(row: AccountRow): ManagedAccount {
  return {
    ...AccountSchema.parse({
      label: row.label,
      email: row.email ?? undefined,
      planType: row.plan_type ?? undefined,
      userId: row.user_id ?? undefined,
      refreshToken: row.refresh_token,
      accessToken: row.access_token,
      tokenExpires: row.token_expires,
      accountId: row.account_id ?? undefined,
      addedAt: row.added_at,
      lastUsed: row.last_used,
      enabled: Boolean(row.enabled),
      activeLimitId: row.active_limit_id,
      limits: JSON.parse(row.limits_json) as unknown,
      rateLimitResetTime: row.rate_limit_reset_time ?? undefined,
    }),
    storageId: row.id,
  }
}

function openDatabase() {
  const db = new Database(getAccountsDbPath(), { create: true })
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA busy_timeout = 5000")
  db.run(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY,
      label TEXT NOT NULL,
      email TEXT,
      plan_type TEXT,
      user_id TEXT,
      refresh_token TEXT NOT NULL,
      access_token TEXT NOT NULL,
      token_expires INTEGER NOT NULL,
      account_id TEXT,
      added_at INTEGER NOT NULL,
      last_used INTEGER NOT NULL,
      enabled INTEGER NOT NULL,
      active_limit_id TEXT NOT NULL,
      limits_json TEXT NOT NULL,
      rate_limit_reset_time INTEGER,
      position INTEGER NOT NULL UNIQUE
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS store_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)
  return db
}

function readManagedStore(db: Database): ManagedStore {
  const rows = db.query(`
    SELECT
      id,
      label,
      email,
      plan_type,
      user_id,
      refresh_token,
      access_token,
      token_expires,
      account_id,
      added_at,
      last_used,
      enabled,
      active_limit_id,
      limits_json,
      rate_limit_reset_time,
      position
    FROM accounts
    ORDER BY position ASC, id ASC
  `).all() as AccountRow[]
  const accounts = rows.map((row) => rowToAccount(row))
  const active = db.query("SELECT value FROM store_meta WHERE key = ?").get("active_account_id") as { value: string } | null
  const activeId = active ? Number.parseInt(active.value, 10) : NaN
  const activeIndex = Number.isInteger(activeId) ? accounts.findIndex((account) => account.storageId === activeId) : -1
  return {
    version: 1,
    activeIndex: clampActiveIndex(activeIndex, accounts.length),
    accounts,
  }
}

function readRefreshLock(db: Database) {
  const row = db.query("SELECT value FROM store_meta WHERE key = ?").get(REFRESH_LOCK_KEY) as MetaRow | null
  if (!row) return
  try {
    return RefreshLockSchema.parse(JSON.parse(row.value))
  } catch {
    return
  }
}

function writeRefreshLock(db: Database, lock: RefreshLock) {
  db.run(
    "INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [REFRESH_LOCK_KEY, JSON.stringify(lock)],
  )
}

function writeManagedStore(db: Database, store: ManagedStore) {
  const next = normalizeStore(store)
  const insert = db.query(`
    INSERT INTO accounts (
      id,
      label,
      email,
      plan_type,
      user_id,
      refresh_token,
      access_token,
      token_expires,
      account_id,
      added_at,
      last_used,
      enabled,
      active_limit_id,
      limits_json,
      rate_limit_reset_time,
      position
    ) VALUES (
      $id,
      $label,
      $email,
      $planType,
      $userId,
      $refreshToken,
      $accessToken,
      $tokenExpires,
      $accountId,
      $addedAt,
      $lastUsed,
      $enabled,
      $activeLimitId,
      $limitsJson,
      $rateLimitResetTime,
      $position
    )
  `)

  db.run("DELETE FROM accounts")

  for (const [position, account] of next.accounts.entries()) {
    const result = insert.run({
      $id: account.storageId ?? null,
      $label: account.label,
      $email: account.email ?? null,
      $planType: account.planType ?? null,
      $userId: account.userId ?? null,
      $refreshToken: account.refreshToken,
      $accessToken: account.accessToken,
      $tokenExpires: account.tokenExpires,
      $accountId: account.accountId ?? null,
      $addedAt: account.addedAt,
      $lastUsed: account.lastUsed,
      $enabled: account.enabled ? 1 : 0,
      $activeLimitId: account.activeLimitId,
      $limitsJson: JSON.stringify(account.limits),
      $rateLimitResetTime: account.rateLimitResetTime ?? null,
      $position: position,
    })
    account.storageId = account.storageId ?? Number(result.lastInsertRowid)
  }

  db.run("DELETE FROM store_meta WHERE key = ?", ["active_account_id"])
  const active = next.accounts[next.activeIndex]
  if (active?.storageId) {
    db.run("INSERT INTO store_meta (key, value) VALUES (?, ?)", ["active_account_id", String(active.storageId)])
  }

  return next
}

export function getConfigDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(xdg, "opencode")
}

export function getAccountsDbPath() {
  return join(getConfigDir(), "codex-accounts.sqlite")
}

export async function loadManagedStore(): Promise<ManagedStore> {
  await mkdir(getConfigDir(), { recursive: true })
  const db = openDatabase()
  try {
    return readManagedStore(db)
  } finally {
    db.close()
  }
}

export async function loadStore(): Promise<Store> {
  return stripStore(await loadManagedStore())
}

export async function saveStore(store: Store | ManagedStore): Promise<Store> {
  await mkdir(getConfigDir(), { recursive: true })
  const db = openDatabase()
  try {
    const replace = db.transaction((input: Store | ManagedStore) => {
      const next = writeManagedStore(db, normalizeStore(input))
      return stripStore(next)
    })
    return replace.immediate(clone(store))
  } finally {
    db.close()
  }
}

export async function updateStore(mutator: (store: ManagedStore) => void): Promise<ManagedStore> {
  await mkdir(getConfigDir(), { recursive: true })
  const db = openDatabase()
  try {
    const apply = db.transaction((change: (store: ManagedStore) => void) => {
      const store = readManagedStore(db)
      change(store)
      return writeManagedStore(db, store)
    })
    return apply.immediate(mutator)
  } finally {
    db.close()
  }
}

export async function tryAcquireRefreshLock(owner: string, expiresAt: number, at = Date.now()) {
  await mkdir(getConfigDir(), { recursive: true })
  const db = openDatabase()
  try {
    const acquire = db.transaction((lockOwner: string, lockExpiresAt: number, now: number) => {
      const current = readRefreshLock(db)
      if (current && current.expiresAt > now) return false
      writeRefreshLock(db, { owner: lockOwner, expiresAt: lockExpiresAt })
      return true
    })
    return acquire.immediate(owner, expiresAt, at)
  } finally {
    db.close()
  }
}

export async function extendRefreshLock(owner: string, expiresAt: number) {
  await mkdir(getConfigDir(), { recursive: true })
  const db = openDatabase()
  try {
    const extend = db.transaction((lockOwner: string, lockExpiresAt: number) => {
      const current = readRefreshLock(db)
      if (current?.owner !== lockOwner) return false
      writeRefreshLock(db, { owner: lockOwner, expiresAt: lockExpiresAt })
      return true
    })
    return extend.immediate(owner, expiresAt)
  } finally {
    db.close()
  }
}

export async function releaseRefreshLock(owner: string) {
  await mkdir(getConfigDir(), { recursive: true })
  const db = openDatabase()
  try {
    const release = db.transaction((lockOwner: string) => {
      const current = readRefreshLock(db)
      if (current?.owner === lockOwner) db.run("DELETE FROM store_meta WHERE key = ?", [REFRESH_LOCK_KEY])
    })
    release.immediate(owner)
  } finally {
    db.close()
  }
}
