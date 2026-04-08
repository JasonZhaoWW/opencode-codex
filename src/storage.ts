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
