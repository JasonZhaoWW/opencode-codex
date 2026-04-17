import { randomBytes } from "node:crypto"
import { access, chmod, mkdir, readFile, rename, rmdir, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
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

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function lock(dir: string) {
  const path = join(dir, ".codex-accounts.lock")
  let delay = 100
  for (let i = 0; i <= 5; i++) {
    try {
      await mkdir(path)
      return async () => {
        await rmdir(path).catch(() => undefined)
      }
    } catch {
      const info = await stat(path).catch(() => undefined)
      if (info && Date.now() - info.mtimeMs > 10_000) {
        await rmdir(path).catch(() => undefined)
        continue
      }
      if (i === 5) throw new Error("Failed to acquire storage lock")
      await sleep(delay)
      delay = Math.min(delay * 2, 1000)
    }
  }
  throw new Error("Failed to acquire storage lock")
}

const Account = z.object({
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

const Store = z.object({
  version: z.literal(1),
  activeIndex: z.number().int().nonnegative(),
  accounts: z.array(Account),
})

export type Account = z.infer<typeof Account>
export type Store = z.infer<typeof Store>

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function matchAccountIndex(accounts: Account[], current: Account, fallback: number, used = new Set<number>()) {
  const byIdentity = current.userId && current.accountId
    ? accounts.findIndex((acc, index) => !used.has(index) && acc.userId === current.userId && acc.accountId === current.accountId)
    : -1
  if (byIdentity >= 0) return byIdentity
  if (current.userId && current.accountId) return -1
  const byRefreshToken = !current.userId && !current.accountId && current.refreshToken
    ? accounts.findIndex((acc, index) => !used.has(index) && acc.refreshToken === current.refreshToken)
    : -1
  if (byRefreshToken >= 0) return byRefreshToken
  return fallback >= 0 && fallback < accounts.length && !used.has(fallback) ? fallback : -1
}

function updateAccount(target: Account, previous: Account, next: Account) {
  const keys = new Set<keyof Account>([
    ...Object.keys(previous),
    ...Object.keys(next),
  ] as Array<keyof Account>)
  // Conflicts are resolved per field: the write that persists later wins only for
  // the fields it changed, while unrelated fields from earlier writes stay intact.
  for (const key of keys) {
    if (sameValue(previous[key], next[key])) continue
    const value = next[key]
    if (value === undefined) delete (target as Record<string, unknown>)[key]
    else (target as Record<string, unknown>)[key] = clone(value)
  }
}

function insertAccountIndex(merged: Store, next: Store, usedNext: Set<number>, nextIndex: number) {
  for (let index = nextIndex + 1; index < next.accounts.length; index++) {
    if (!usedNext.has(index)) continue
    const anchor = next.accounts[index]
    if (!anchor) continue
    const hit = matchAccountIndex(merged.accounts, anchor, -1)
    if (hit >= 0) return hit
  }
  for (let index = nextIndex - 1; index >= 0; index--) {
    if (!usedNext.has(index)) continue
    const anchor = next.accounts[index]
    if (!anchor) continue
    const hit = matchAccountIndex(merged.accounts, anchor, -1)
    if (hit >= 0) return hit + 1
  }
  return merged.accounts.length
}

function mergeStore(latest: Store, previous: Store, next: Store) {
  const merged = clone(latest)
  const nextByPrevious = new Map<number, number>()
  const usedNext = new Set<number>()

  for (const [index, account] of previous.accounts.entries()) {
    const hit = matchAccountIndex(next.accounts, account, index, usedNext)
    if (hit < 0) continue
    nextByPrevious.set(index, hit)
    usedNext.add(hit)
  }

  for (const [previousIndex, nextIndex] of nextByPrevious.entries()) {
    const previousAccount = previous.accounts[previousIndex]
    const nextAccount = next.accounts[nextIndex]
    if (!previousAccount || !nextAccount) continue
    const targetIndex = matchAccountIndex(merged.accounts, previousAccount, previousIndex)
    if (targetIndex < 0) continue
    updateAccount(merged.accounts[targetIndex]!, previousAccount, nextAccount)
  }

  for (const [previousIndex, previousAccount] of previous.accounts.entries()) {
    if (nextByPrevious.has(previousIndex)) continue
    const targetIndex = matchAccountIndex(merged.accounts, previousAccount, previousIndex)
    if (targetIndex >= 0) merged.accounts.splice(targetIndex, 1)
  }

  for (const [nextIndex, nextAccount] of next.accounts.entries()) {
    if (usedNext.has(nextIndex)) continue
    const targetIndex = matchAccountIndex(merged.accounts, nextAccount, -1)
    if (targetIndex >= 0) merged.accounts[targetIndex] = { ...merged.accounts[targetIndex]!, ...clone(nextAccount) }
    else merged.accounts.splice(insertAccountIndex(merged, next, usedNext, nextIndex), 0, clone(nextAccount))
  }

  if (previous.activeIndex !== next.activeIndex) {
    const active = next.accounts[next.activeIndex]
    if (!active) merged.activeIndex = 0
    else {
      const hit = matchAccountIndex(merged.accounts, active, next.activeIndex)
      if (hit >= 0) merged.activeIndex = hit
    }
  }

  if (merged.accounts.length === 0) merged.activeIndex = 0
  else merged.activeIndex = Math.max(0, Math.min(merged.activeIndex, merged.accounts.length - 1))

  return merged
}

function emptyStore(): Store {
  return {
    version: 1,
    activeIndex: 0,
    accounts: [],
  }
}

async function readStore(file: string): Promise<Store> {
  try {
    await access(file)
    const text = await readFile(file, "utf8")
    return Store.parse(JSON.parse(text))
  } catch {
    return emptyStore()
  }
}

async function writeStore(file: string, store: Store) {
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`
  await writeFile(tmp, JSON.stringify(store, null, 2) + "\n", "utf8")
  await chmod(tmp, 0o600)
  await rename(tmp, file)
}

export function getConfigDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(xdg, "opencode")
}

export function getAccountsPath() {
  return join(getConfigDir(), "codex-accounts.json")
}

export async function loadStore(): Promise<Store> {
  return readStore(getAccountsPath())
}

export async function saveStore(store: Store) {
  const file = getAccountsPath()
  const dir = dirname(file)
  await mkdir(dir, { recursive: true })
  const release = await lock(dir)
  try {
    await writeStore(file, store)
  } finally {
    await release()
  }
}

export async function saveStoreReconciled(previous: Store, next: Store) {
  const file = getAccountsPath()
  const dir = dirname(file)
  await mkdir(dir, { recursive: true })
  const release = await lock(dir)
  try {
    const latest = await readStore(file)
    const merged = mergeStore(latest, previous, next)
    await writeStore(file, merged)
    return merged
  } finally {
    await release()
  }
}

export async function updateStore(mutator: (store: Store) => void | Promise<void>) {
  const file = getAccountsPath()
  const dir = dirname(file)
  await mkdir(dir, { recursive: true })
  const release = await lock(dir)
  try {
    const store = await readStore(file)
    await mutator(store)
    await writeStore(file, store)
    return store
  } finally {
    await release()
  }
}
