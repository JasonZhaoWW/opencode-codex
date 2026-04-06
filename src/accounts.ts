import type { PluginInput } from "@opencode-ai/plugin"
import { DEFAULT_LIMIT_ID, DEFAULT_LIMIT_MS, LIMIT_STALE_MS } from "./constants.js"
import { fetchUsageLimits, limitBlocked, limitReset, normalizeLimitId, type LimitMap } from "./limits.js"
import { accessExpired, extractAccountId, extractEmail, refreshAccessToken, tokenExpires, type TokenResponse } from "./oauth.js"
import { loadStore, saveStore, type Account, type Store } from "./storage.js"

type Client = PluginInput["client"]

type RawClient = {
  _client: {
    delete: (opts: { url: string }) => Promise<unknown>
  }
}

function now() {
  return Date.now()
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
    return new AccountManager(await loadStore(), client)
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
    this.store.accounts.push({
      label: "primary",
      refreshToken: auth.refresh,
      accessToken: auth.access,
      tokenExpires: auth.expires,
      accountId: auth.accountId,
      addedAt: now(),
        lastUsed: 0,
        enabled: true,
        activeLimitId: DEFAULT_LIMIT_ID,
        limits: {},
      })
    await saveStore(this.store)
    await this.hydrate(0).catch(() => undefined)
  }

  private active(acc: Account) {
    return normalizeLimitId(acc.activeLimitId)
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
      acc.accountId = extractAccountId(token) || acc.accountId
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
    const limits = await fetchUsageLimits(acc.accessToken, acc.accountId)
    this.captureLimits(index, limits, undefined, true)
    clearTimeout(this.saveTimer)
    await saveStore(this.store)
    return this.store.accounts[index]
  }

  async add(token: TokenResponse, label: string) {
    const acc: Account = {
      label,
      email: extractEmail(token),
      refreshToken: token.refresh_token,
      accessToken: token.access_token,
      tokenExpires: tokenExpires(token.expires_in),
      accountId: extractAccountId(token),
      addedAt: now(),
      lastUsed: 0,
      enabled: true,
      activeLimitId: DEFAULT_LIMIT_ID,
      limits: {},
    }
    const hit = this.store.accounts.findIndex((item) => item.refreshToken === acc.refreshToken)
    if (hit >= 0) this.store.accounts[hit] = { ...this.store.accounts[hit]!, ...acc }
    else this.store.accounts.push(acc)
    if (this.store.accounts.length === 1) this.store.activeIndex = 0
    await saveStore(this.store)
    await this.sync()
    await this.hydrate(hit >= 0 ? hit : this.store.accounts.length - 1).catch(() => undefined)
    return acc
  }

  async remove(index: number) {
    if (index < 0 || index >= this.store.accounts.length) return
    this.store.accounts.splice(index, 1)
    if (this.store.activeIndex >= this.store.accounts.length) this.store.activeIndex = Math.max(0, this.store.accounts.length - 1)
    await saveStore(this.store)
    await this.sync()
  }

  async toggle(index: number) {
    const acc = this.store.accounts[index]
    if (!acc) return
    acc.enabled = !acc.enabled
    await saveStore(this.store)
    await this.sync()
  }

  async rename(index: number, label: string) {
    const acc = this.store.accounts[index]
    if (!acc) return
    acc.label = label
    await saveStore(this.store)
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
      void saveStore(this.store)
    }, 1000)
  }
}
