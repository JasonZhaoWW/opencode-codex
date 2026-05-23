import type { PluginInput } from "@opencode-ai/plugin"
import { clearInterval, setInterval } from "node:timers"
import { setTimeout as sleep } from "node:timers/promises"
import { DEFAULT_LIMIT_ID, DEFAULT_LIMIT_MS, LIMIT_STALE_MS } from "./constants.js"
import { fetchUsageLimits, limitBlocked, limitReset, normalizeLimitId, type LimitMap } from "./limits.js"
import { accessExpired, extractAccountIdentity, extractEmail, isPermanentTokenRefreshError, refreshAccessToken, tokenExpires, type TokenIdentity, type TokenResponse } from "./oauth.js"
import { extendRefreshLock, loadManagedStore, releaseRefreshLock, tryAcquireRefreshLock, updateStore, type Account, type ManagedAccount, type ManagedStore } from "./storage.js"

type Client = PluginInput["client"]

type RawClient = {
  _client: {
    delete: (opts: { url: string }) => Promise<unknown>
  }
}

function now() {
  return Date.now()
}

const REFRESH_LOCK_LEASE_MS = 2 * 60 * 1000
const REFRESH_LOCK_POLL_MS = 50

async function acquireRefreshLock() {
  const owner = `${process.pid}-${now()}-${Math.random().toString(36).slice(2)}`
  while (true) {
    if (await tryAcquireRefreshLock(owner, now() + REFRESH_LOCK_LEASE_MS)) {
      const heartbeat = setInterval(() => {
        void extendRefreshLock(owner, now() + REFRESH_LOCK_LEASE_MS).catch(() => undefined)
      }, Math.floor(REFRESH_LOCK_LEASE_MS / 2))
      heartbeat.unref()
      let released = false
      return async () => {
        if (released) return
        released = true
        clearInterval(heartbeat)
        await releaseRefreshLock(owner)
      }
    }
    await sleep(REFRESH_LOCK_POLL_MS)
  }
}

async function withRefreshLock<T>(fn: () => Promise<T>) {
  const release = await acquireRefreshLock()
  try {
    return await fn()
  } finally {
    await release()
  }
}

function applyIdentity(acc: Account, identity: TokenIdentity) {
  let changed = false
  if (identity.planType && acc.planType !== identity.planType) {
    acc.planType = identity.planType
    changed = true
  }
  if (identity.userId && acc.userId !== identity.userId) {
    acc.userId = identity.userId
    changed = true
  }
  if (identity.accountId && acc.accountId !== identity.accountId) {
    acc.accountId = identity.accountId
    changed = true
  }
  return changed
}

export class AccountManager {
  private store: ManagedStore
  private client: Client

  private constructor(store: ManagedStore, client: Client) {
    this.store = store
    this.client = client
  }

  static async load(client: Client) {
    let store = await loadManagedStore()
    const changed = store.accounts.reduce((hit, acc) => {
      return applyIdentity(acc, extractAccountIdentity({ access_token: acc.accessToken })) || hit
    }, false)
    if (changed) {
      store = await updateStore((latest) => {
        for (const account of latest.accounts) {
          applyIdentity(account, extractAccountIdentity({ access_token: account.accessToken }))
        }
      })
    }
    return new AccountManager(store, client)
  }

  list() {
    return this.store.accounts
  }

  currentIndex() {
    return this.store.activeIndex
  }

  async reload() {
    this.store = await loadManagedStore()
  }

  async ensureFromAuth(auth: { type: string; refresh?: string; access?: string; expires?: number; accountId?: string }) {
    if (auth.type !== "oauth") return
    if (this.store.accounts.length > 0) return
    if (!auth.refresh || !auth.access || !auth.expires) return
    let seeded = false
    this.store = await updateStore((store) => {
      if (store.accounts.length > 0) return
      store.accounts.push({
        label: "primary",
        refreshToken: auth.refresh!,
        accessToken: auth.access!,
        tokenExpires: auth.expires!,
        accountId: auth.accountId,
        addedAt: now(),
        lastUsed: 0,
        enabled: true,
        activeLimitId: DEFAULT_LIMIT_ID,
        limits: {},
      })
      seeded = true
    })
    if (seeded) await this.hydrate(0).catch(() => undefined)
  }

  private active(acc: Account) {
    return normalizeLimitId(acc.activeLimitId)
  }

  private matchAccountIndex(accounts: ManagedAccount[], current: Partial<ManagedAccount>, fallback: number) {
    const byStorageId = typeof current.storageId === "number"
      ? accounts.findIndex((acc) => acc.storageId === current.storageId)
      : -1
    if (byStorageId >= 0) return byStorageId
    const byIdentity = current.userId && current.accountId
      ? accounts.findIndex((acc) => acc.userId === current.userId && acc.accountId === current.accountId)
      : -1
    if (byIdentity >= 0) return byIdentity
    if (current.userId && current.accountId) return -1
    const byRefreshToken = !current.userId && !current.accountId && current.refreshToken
      ? accounts.findIndex((acc) => acc.refreshToken === current.refreshToken)
      : -1
    if (byRefreshToken >= 0) return byRefreshToken
    const byEmail = current.email ? accounts.findIndex((acc) => acc.email === current.email) : -1
    if (byEmail >= 0) return byEmail
    return fallback >= 0 && fallback < accounts.length ? fallback : -1
  }

  private findExistingAccountIndex(account: Partial<ManagedAccount>, accounts = this.store.accounts) {
    return this.matchAccountIndex(accounts, account, -1)
  }

  private findCurrentIndex(current: Partial<ManagedAccount>, fallback = -1) {
    return this.matchAccountIndex(this.store.accounts, current, fallback)
  }

  private activeUnchanged(store: ManagedStore, active: ManagedAccount | undefined) {
    if (!active) return store.accounts.length === 0
    return this.matchAccountIndex(store.accounts, active, -1) === store.activeIndex
  }

  private async mutateCurrent(
    current: ManagedAccount,
    fallback: number,
    mutator: (account: ManagedAccount, store: ManagedStore, index: number) => void,
  ) {
    this.store = await updateStore((store) => {
      const hit = this.matchAccountIndex(store.accounts, current, fallback)
      if (hit < 0) return
      mutator(store.accounts[hit]!, store, hit)
    })
    return this.findCurrentIndex(current, fallback)
  }

  private fresh(acc: Account) {
    const id = this.active(acc)
    const hit = acc.limits[id] || acc.limits[DEFAULT_LIMIT_ID]
    return Boolean(hit && hit.capturedAt > now() - LIMIT_STALE_MS)
  }

  private reset(acc: Account) {
    if (acc.rateLimitResetTime && acc.rateLimitResetTime <= now()) delete acc.rateLimitResetTime
    const id = this.active(acc)
    const hit = acc.limits[id] || acc.limits[DEFAULT_LIMIT_ID]
    return [acc.rateLimitResetTime, limitReset(hit, now())]
      .filter((value): value is number => typeof value === "number")
      .sort((a, b) => a - b)[0]
  }

  private blocked(acc: Account) {
    if (acc.rateLimitResetTime && acc.rateLimitResetTime <= now()) delete acc.rateLimitResetTime
    if (acc.rateLimitResetTime) return true
    const id = this.active(acc)
    return limitBlocked(acc.limits[id] || acc.limits[DEFAULT_LIMIT_ID], now())
  }

  private async available(i: number) {
    const acc = this.store.accounts[i]
    if (!acc) return false
    if (!acc.enabled) return false
    if (!this.fresh(acc)) await this.hydrate(i).catch(() => undefined)
    const hit = this.findCurrentIndex(acc, i)
    if (hit < 0) return false
    return !this.blocked(this.store.accounts[hit]!)
  }

  private async next(skip = -1) {
    if (this.store.accounts.length === 0) {
      throw new Error("No ChatGPT accounts configured. Run opencode auth login --provider openai.")
    }
    const start = this.store.activeIndex
    if (start !== skip && (await this.available(start))) return start
    for (let n = 0; n < this.store.accounts.length; n++) {
      const i = (start + n + 1) % this.store.accounts.length
      if (i === skip) continue
      if (await this.available(i)) return i
    }
    const soon = this.store.accounts
      .map((acc) => this.reset(acc))
      .filter((val): val is number => typeof val === "number")
      .sort((a, b) => a - b)[0]
    const msg = soon ? `All accounts are rate-limited. Soonest reset: ${new Date(soon).toLocaleString()}` : "No enabled ChatGPT accounts available."
    throw new Error(msg)
  }

  async select(skip = -1) {
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.reload()
      const active = this.store.accounts[this.store.activeIndex]
      const i = await this.next(skip)
      const acc = this.store.accounts[i]!
      const lastUsed = now()
      let changed = false
      let selected: ManagedAccount | undefined
      this.store = await updateStore((store) => {
        if (!this.activeUnchanged(store, active)) {
          changed = true
          return
        }
        const hit = this.matchAccountIndex(store.accounts, acc, i)
        if (hit < 0) return
        store.activeIndex = hit
        selected = store.accounts[hit]!
        selected.lastUsed = lastUsed
      })
      if (changed) continue
      if (selected) {
        const index = this.findCurrentIndex(selected, this.store.activeIndex)
        return { index, account: this.store.accounts[index]! }
      }
    }
    throw new Error("Current account changed during selection. Try again.")
  }

  async setCurrent(index: number) {
    const acc = this.store.accounts[index]
    if (!acc) return false
    let updated = false
    this.store = await updateStore((store) => {
      const hit = this.matchAccountIndex(store.accounts, acc, index)
      if (hit < 0) return
      const current = store.accounts[hit]!
      if (!current.enabled || this.blocked(current)) return
      store.activeIndex = hit
      updated = true
    })
    return updated
  }

  async markRateLimited(index: number, reset = now() + DEFAULT_LIMIT_MS, active = DEFAULT_LIMIT_ID) {
    const acc = this.store.accounts[index]
    if (!acc) return
    await this.mutateCurrent(acc, index, (current) => {
      current.activeLimitId = normalizeLimitId(active)
      current.rateLimitResetTime = reset
    })
  }

  async captureLimits(index: number, limits: LimitMap, active?: string, clear = false) {
    const acc = this.store.accounts[index]
    if (!acc) return -1
    return this.mutateCurrent(acc, index, (current) => {
      for (const [id, snap] of Object.entries(limits)) {
        const prev = current.limits[id]
        current.limits[id] = {
          ...snap,
          ...(prev?.limitName && !snap.limitName ? { limitName: prev.limitName } : {}),
        }
      }
      if (active) current.activeLimitId = normalizeLimitId(active)
      if (clear && Object.keys(limits).length > 0) delete current.rateLimitResetTime
    })
  }

  async refresh(index: number, sync = true, force = false) {
    const acc = this.store.accounts[index]
    if (!acc) throw new Error("Missing account")
    try {
      const refreshed = await withRefreshLock(async () => {
        this.store = await loadManagedStore()
        const hit = this.findCurrentIndex(acc, index)
        if (hit < 0) throw new Error("Missing account")
        const current = this.store.accounts[hit]!
        const changed = current.accessToken !== acc.accessToken || current.refreshToken !== acc.refreshToken || current.tokenExpires !== acc.tokenExpires
        if (current.refreshToken !== acc.refreshToken || (!force && !accessExpired(current.tokenExpires)) || (force && changed && !accessExpired(current.tokenExpires))) {
          return { account: current, index: hit, remote: false }
        }

        const token = await refreshAccessToken(current.refreshToken)
        this.store = await updateStore((store) => {
          const latest = this.matchAccountIndex(store.accounts, current, hit)
          if (latest < 0) throw new Error("Missing account")
          const target = store.accounts[latest]!
          target.accessToken = token.access_token
          target.refreshToken = token.refresh_token || target.refreshToken
          target.tokenExpires = tokenExpires(token.expires_in)
          applyIdentity(target, extractAccountIdentity(token))
          target.email = extractEmail(token) || target.email
        })
        const saved = this.findCurrentIndex(current, hit)
        if (saved < 0) throw new Error("Missing account")
        return { account: this.store.accounts[saved]!, index: saved, remote: true }
      })
      if (sync && refreshed.remote) await this.hydrate(refreshed.index, false).catch(() => undefined)
      return refreshed.account
    } catch (err) {
      if (isPermanentTokenRefreshError(err)) {
        await this.mutateCurrent(acc, index, (current) => {
          current.enabled = false
        })
        await this.sync()
      }
      throw err
    }
  }

  async quota(index: number) {
    let hit = index
    let acc = this.store.accounts[hit]
    if (!acc) throw new Error("Missing account")
    if (accessExpired(acc.tokenExpires)) {
      acc = await this.refresh(hit, false)
      hit = this.findCurrentIndex(acc, hit)
    }
    if (hit < 0) throw new Error("Missing account")
    const current = this.store.accounts[hit]
    if (!current) throw new Error("Missing account")
    const limits = await fetchUsageLimits(current.accessToken, current.accountId)
    hit = await this.captureLimits(hit, limits, undefined, true)
    return hit >= 0 ? this.store.accounts[hit] : undefined
  }

  async add(token: TokenResponse, label: string) {
    const acc: ManagedAccount = {
      label,
      email: extractEmail(token),
      refreshToken: token.refresh_token,
      accessToken: token.access_token,
      tokenExpires: tokenExpires(token.expires_in),
      addedAt: now(),
      lastUsed: 0,
      enabled: true,
      activeLimitId: DEFAULT_LIMIT_ID,
      limits: {},
    }
    applyIdentity(acc, extractAccountIdentity(token))
    this.store = await updateStore((store) => {
      const hit = this.findExistingAccountIndex(acc, store.accounts)
      if (hit >= 0) {
        const storageId = store.accounts[hit]!.storageId
        store.accounts[hit] = { ...store.accounts[hit]!, ...acc, ...(storageId ? { storageId } : {}) }
      } else {
        store.accounts.push(acc)
      }
      if (store.accounts.length === 1) store.activeIndex = 0
    })
    await this.sync()
    const savedIndex = this.findExistingAccountIndex(acc)
    await this.hydrate(savedIndex >= 0 ? savedIndex : this.store.accounts.length - 1).catch(() => undefined)
    return savedIndex >= 0 ? this.store.accounts[savedIndex]! : acc
  }

  async remove(index: number) {
    const acc = this.store.accounts[index]
    if (!acc) return
    this.store = await updateStore((store) => {
      const hit = this.matchAccountIndex(store.accounts, acc, index)
      if (hit < 0) return
      store.accounts.splice(hit, 1)
      if (store.activeIndex >= store.accounts.length) store.activeIndex = Math.max(0, store.accounts.length - 1)
    })
    await this.sync()
  }

  async toggle(index: number) {
    const acc = this.store.accounts[index]
    if (!acc) return
    await this.mutateCurrent(acc, index, (current) => {
      current.enabled = !current.enabled
    })
    await this.sync()
  }

  async rename(index: number, label: string) {
    const acc = this.store.accounts[index]
    if (!acc) return
    await this.mutateCurrent(acc, index, (current) => {
      current.label = label
    })
  }

  private async hydrate(index: number, refresh = true) {
    let hit = index
    let acc = this.store.accounts[hit]
    if (!acc || !acc.enabled) return
    if (refresh && accessExpired(acc.tokenExpires)) {
      acc = await this.refresh(hit, false)
      hit = this.findCurrentIndex(acc, hit)
    }
    if (hit < 0) return
    const current = this.store.accounts[hit]
    if (!current || !current.enabled) return
    const limits = await fetchUsageLimits(current.accessToken, current.accountId)
    await this.captureLimits(hit, limits, undefined, true)
  }

  private async sync() {
    const acc = this.store.accounts[0]
    if (!acc) {
      const raw = this.client as unknown as RawClient
      await raw._client.delete({ url: "/auth/openai" }).catch(() => undefined)
      return
    }
    await this.client.auth.set({
      path: { id: "openai" },
      body: {
        type: "oauth",
        refresh: acc.refreshToken,
        access: acc.accessToken,
        expires: acc.tokenExpires,
        ...(acc.accountId ? { accountId: acc.accountId } : {}),
      },
    })
  }
}
