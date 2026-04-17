import type { PluginInput } from "@opencode-ai/plugin"
import { DEFAULT_LIMIT_ID, DEFAULT_LIMIT_MS, LIMIT_STALE_MS } from "./constants.js"
import { fetchUsageLimits, limitBlocked, limitReset, normalizeLimitId, type LimitMap } from "./limits.js"
import { accessExpired, extractAccountIdentity, extractEmail, refreshAccessToken, tokenExpires, type TokenIdentity, type TokenResponse } from "./oauth.js"
import { loadStore, saveStoreReconciled, updateStore, type Account, type Store } from "./storage.js"

type Client = PluginInput["client"]

type RawClient = {
  _client: {
    delete: (opts: { url: string }) => Promise<unknown>
  }
}

function now() {
  return Date.now()
}

function cloneStore(store: Store) {
  return JSON.parse(JSON.stringify(store)) as Store
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
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private store: Store
  private client: Client

  private constructor(store: Store, client: Client) {
    this.store = store
    this.client = client
  }

  static async load(client: Client) {
    const store = await loadStore()
    const previous = cloneStore(store)
    const changed = store.accounts.reduce((hit, acc) => {
      return applyIdentity(acc, extractAccountIdentity({ access_token: acc.accessToken })) || hit
    }, false)
    const current = changed ? await saveStoreReconciled(previous, store) : store
    return new AccountManager(current, client)
  }

  list() {
    return this.store.accounts
  }

  currentIndex() {
    return this.store.activeIndex
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

  private matchAccountIndex(accounts: Account[], current: Account, fallback: number) {
    const byIdentity = current.userId && current.accountId
      ? accounts.findIndex((acc) => acc.userId === current.userId && acc.accountId === current.accountId)
      : -1
    if (byIdentity >= 0) return byIdentity
    const byRefreshToken = !current.userId && !current.accountId
      ? accounts.findIndex((acc) => acc.refreshToken === current.refreshToken)
      : -1
    if (byRefreshToken >= 0) return byRefreshToken
    const byEmail = current.email ? accounts.findIndex((acc) => acc.email === current.email) : -1
    if (byEmail >= 0) return byEmail
    return fallback >= 0 && fallback < accounts.length ? fallback : -1
  }

  private findExistingAccountIndex(account: Account) {
    const byIdentity = account.userId && account.accountId
      ? this.store.accounts.findIndex((item) => item.userId === account.userId && item.accountId === account.accountId)
      : -1
    if (byIdentity >= 0) return byIdentity
    if (!account.userId && !account.accountId) {
      const byRefreshToken = this.store.accounts.findIndex((item) => item.refreshToken === account.refreshToken)
      if (byRefreshToken >= 0) return byRefreshToken
    }
    return -1
  }

  private async persistStore(previous: Store) {
    this.store = await saveStoreReconciled(previous, this.store)
    return this.store
  }

  private mergeBackgroundState(store: Store) {
    const current = this.store.accounts
    for (const [index, account] of current.entries()) {
      const hit = this.matchAccountIndex(store.accounts, account, index)
      if (hit < 0) continue
      store.accounts[hit] = {
        ...store.accounts[hit]!,
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        tokenExpires: account.tokenExpires,
        planType: account.planType,
        userId: account.userId,
        accountId: account.accountId,
        email: account.email,
        lastUsed: account.lastUsed,
        enabled: account.enabled,
        activeLimitId: account.activeLimitId,
        limits: account.limits,
        ...(typeof account.rateLimitResetTime === "number" ? { rateLimitResetTime: account.rateLimitResetTime } : {}),
      }
      if (typeof account.rateLimitResetTime !== "number") delete store.accounts[hit]!.rateLimitResetTime
    }
    if (store.accounts.length === 0) store.activeIndex = 0
    else store.activeIndex = Math.max(0, Math.min(this.store.activeIndex, store.accounts.length - 1))
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
    return !this.blocked(this.store.accounts[i]!)
  }

  private async next(skip = -1) {
    if (this.store.accounts.length === 0) {
      throw new Error("No ChatGPT accounts configured. Run opencode auth login --provider openai.")
    }
    if ((await this.available(this.store.activeIndex)) && this.store.activeIndex !== skip) return this.store.activeIndex
    for (let n = 0; n < this.store.accounts.length; n++) {
      const i = (this.store.activeIndex + n + 1) % this.store.accounts.length
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
    const i = await this.next(skip)
    this.store.activeIndex = i
    const acc = this.store.accounts[i]!
    acc.lastUsed = now()
    this.requestSave()
    return { index: i, account: acc }
  }

  markRateLimited(index: number, reset = now() + DEFAULT_LIMIT_MS, active = DEFAULT_LIMIT_ID) {
    const acc = this.store.accounts[index]
    if (!acc) return
    acc.activeLimitId = normalizeLimitId(active)
    acc.rateLimitResetTime = reset
    this.requestSave()
  }

  captureLimits(index: number, limits: LimitMap, active?: string, clear = false) {
    const acc = this.store.accounts[index]
    if (!acc) return
    for (const [id, snap] of Object.entries(limits)) {
      const prev = acc.limits[id]
      acc.limits[id] = {
        ...snap,
        ...(prev?.limitName && !snap.limitName ? { limitName: prev.limitName } : {}),
      }
    }
    if (active) acc.activeLimitId = normalizeLimitId(active)
    if (clear && Object.keys(limits).length > 0) delete acc.rateLimitResetTime
    this.requestSave()
  }

  async refresh(index: number, sync = true) {
    const acc = this.store.accounts[index]
    if (!acc) throw new Error("Missing account")
    try {
      const token = await refreshAccessToken(acc.refreshToken)
      acc.accessToken = token.access_token
      acc.refreshToken = token.refresh_token || acc.refreshToken
      acc.tokenExpires = tokenExpires(token.expires_in)
      applyIdentity(acc, extractAccountIdentity(token))
      acc.email = extractEmail(token) || acc.email
      if (sync) await this.hydrate(index, false).catch(() => undefined)
      this.requestSave()
      return acc
    } catch (err) {
      acc.enabled = false
      this.requestSave()
      await this.sync()
      throw err
    }
  }

  async quota(index: number) {
    const acc = this.store.accounts[index]
    if (!acc) throw new Error("Missing account")
    const previous = cloneStore(this.store)
    const limits = await fetchUsageLimits(acc.accessToken, acc.accountId)
    this.captureLimits(index, limits, undefined, true)
    clearTimeout(this.saveTimer)
    await this.persistStore(previous)
    const hit = this.matchAccountIndex(this.store.accounts, acc, index)
    return hit >= 0 ? this.store.accounts[hit] : undefined
  }

  async add(token: TokenResponse, label: string) {
    const previous = cloneStore(this.store)
    const acc: Account = {
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
    const hit = this.findExistingAccountIndex(acc)
    if (hit >= 0) this.store.accounts[hit] = { ...this.store.accounts[hit]!, ...acc }
    else this.store.accounts.push(acc)
    if (this.store.accounts.length === 1) this.store.activeIndex = 0
    await this.persistStore(previous)
    await this.sync()
    const savedIndex = this.findExistingAccountIndex(acc)
    await this.hydrate(savedIndex >= 0 ? savedIndex : this.store.accounts.length - 1).catch(() => undefined)
    return acc
  }

  async remove(index: number) {
    if (index < 0 || index >= this.store.accounts.length) return
    const previous = cloneStore(this.store)
    this.store.accounts.splice(index, 1)
    if (this.store.activeIndex >= this.store.accounts.length) this.store.activeIndex = Math.max(0, this.store.accounts.length - 1)
    await this.persistStore(previous)
    await this.sync()
  }

  async toggle(index: number) {
    const acc = this.store.accounts[index]
    if (!acc) return
    const previous = cloneStore(this.store)
    acc.enabled = !acc.enabled
    await this.persistStore(previous)
    await this.sync()
  }

  async rename(index: number, label: string) {
    const acc = this.store.accounts[index]
    if (!acc) return
    this.store = await updateStore((store) => {
      const hit = this.matchAccountIndex(store.accounts, acc, index)
      if (hit < 0) return
      store.accounts[hit]!.label = label
    })
  }

  private async hydrate(index: number, refresh = true) {
    const acc = this.store.accounts[index]
    if (!acc || !acc.enabled) return
    if (refresh && accessExpired(acc.tokenExpires)) await this.refresh(index, false)
    const cur = this.store.accounts[index]
    if (!cur || !cur.enabled) return
    const limits = await fetchUsageLimits(cur.accessToken, cur.accountId)
    this.captureLimits(index, limits, undefined, true)
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

  requestSave() {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      void updateStore((store) => {
        this.mergeBackgroundState(store)
        this.store = store
      })
    }, 1000)
  }
}
