import { CODEX_USAGE_ENDPOINT, DEFAULT_LIMIT_ID, DEFAULT_LIMIT_MS } from "./constants.js"

export type LimitWindow = {
  usedPercent: number
  windowMinutes?: number
  resetsAt?: number
}

export type LimitSnapshot = {
  capturedAt: number
  limitName?: string
  primary?: LimitWindow
  secondary?: LimitWindow
}

export type LimitMap = Record<string, LimitSnapshot>

type UsageWindow = {
  used_percent?: unknown
  limit_window_seconds?: unknown
  reset_at?: unknown
}

type UsageRate = {
  primary_window?: UsageWindow
  secondary_window?: UsageWindow
}

type UsageExtra = {
  limit_name?: unknown
  metered_feature?: unknown
  rate_limit?: UsageRate
}

type UsageBody = {
  rate_limit?: UsageRate
  additional_rate_limits?: unknown
}

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function int(value: unknown) {
  const hit = num(value)
  return hit === undefined ? undefined : Math.trunc(hit)
}

function readNum(headers: Headers, key: string) {
  const raw = headers.get(key)
  if (!raw) return
  const hit = Number(raw)
  return Number.isFinite(hit) ? hit : undefined
}

function readInt(headers: Headers, key: string) {
  const hit = readNum(headers, key)
  return hit === undefined ? undefined : Math.trunc(hit)
}

function readWindow(used: number | undefined, mins: number | undefined, reset: number | undefined) {
  if (used === undefined) return
  if (used === 0 && mins === undefined && reset === undefined) return
  return {
    usedPercent: used,
    ...(mins !== undefined ? { windowMinutes: mins } : {}),
    ...(reset !== undefined ? { resetsAt: reset } : {}),
  } satisfies LimitWindow
}

function readHeaderWindow(headers: Headers, prefix: string, name: string) {
  return readWindow(
    readNum(headers, `${prefix}-${name}-used-percent`),
    readInt(headers, `${prefix}-${name}-window-minutes`),
    readInt(headers, `${prefix}-${name}-reset-at`),
  )
}

function prefix(id?: string) {
  return `x-${normalizeLimitId(id).replaceAll("_", "-")}`
}

function usageWindow(value: UsageWindow | undefined) {
  if (!value || typeof value !== "object") return
  return readWindow(
    num(value.used_percent),
    (() => {
      const secs = int(value.limit_window_seconds)
      if (secs === undefined) return
      return Math.trunc(secs / 60)
    })(),
    int(value.reset_at),
  )
}

function snapshotFor(headers: Headers, id?: string, at = Date.now()) {
  const pre = prefix(id)
  const primary = readHeaderWindow(headers, pre, "primary")
  const secondary = readHeaderWindow(headers, pre, "secondary")
  const limitName = text(headers.get(`${pre}-limit-name`))
  if (!primary && !secondary && !limitName) return
  return {
    capturedAt: at,
    ...(limitName ? { limitName } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
  } satisfies LimitSnapshot
}

function usageSnapshot(rate: UsageRate | undefined, limitName: string | undefined, at = Date.now()) {
  if (!rate || typeof rate !== "object") return
  const primary = usageWindow(rate.primary_window)
  const secondary = usageWindow(rate.secondary_window)
  if (!primary && !secondary && !limitName) return
  return {
    capturedAt: at,
    ...(limitName ? { limitName } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
  } satisfies LimitSnapshot
}

export function normalizeLimitId(value: string | undefined) {
  const hit = text(value)
  if (!hit) return DEFAULT_LIMIT_ID
  return hit.toLowerCase().replaceAll("-", "_")
}

export function parseLimitHeaders(headers: Headers, at = Date.now()) {
  const out: LimitMap = {}
  const base = snapshotFor(headers, undefined, at)
  if (base) out[DEFAULT_LIMIT_ID] = base
  for (const key of headers.keys()) {
    if (!key.toLowerCase().endsWith("-primary-used-percent")) continue
    const id = normalizeLimitId(key.slice(2, -"-primary-used-percent".length))
    if (id === DEFAULT_LIMIT_ID || out[id]) continue
    const snap = snapshotFor(headers, id, at)
    if (snap) out[id] = snap
  }
  return out
}

export function parseLimitFailure(headers: Headers, at = Date.now()) {
  return {
    activeLimitId: text(headers.get("x-codex-active-limit"))
      ? normalizeLimitId(headers.get("x-codex-active-limit") || undefined)
      : undefined,
    limits: parseLimitHeaders(headers, at),
    resetAt: parseReset(headers, at),
  }
}

export function parseUsageLimits(value: unknown, at = Date.now()) {
  if (!value || typeof value !== "object") return {} satisfies LimitMap
  const body = value as UsageBody
  const out: LimitMap = {}
  const base = usageSnapshot(body.rate_limit, undefined, at)
  if (base) out[DEFAULT_LIMIT_ID] = base
  const extra = Array.isArray(body.additional_rate_limits) ? body.additional_rate_limits : []
  for (const item of extra) {
    if (!item || typeof item !== "object") continue
    const hit = item as UsageExtra
    const id = normalizeLimitId(text(hit.metered_feature) || text(hit.limit_name))
    const limitName = text(hit.limit_name) || text(hit.metered_feature)
    const snap = usageSnapshot(hit.rate_limit, limitName, at)
    if (snap) out[id] = snap
  }
  return out
}

export function parseReset(headers: Headers, at = Date.now()) {
  const retry = headers.get("Retry-After")
  if (retry) {
    const secs = Number.parseInt(retry, 10)
    if (Number.isFinite(secs)) return at + secs * 1000
  }
  const raw = headers.get("x-ratelimit-reset-requests")
  if (!raw) return at + DEFAULT_LIMIT_MS
  const num = Number(raw)
  if (Number.isFinite(num)) {
    if (num > 10_000_000_000) return num
    if (num > 0) return at + num * 1000
  }
  const ts = Date.parse(raw)
  if (Number.isFinite(ts)) return ts
  return at + DEFAULT_LIMIT_MS
}

function blocked(win: LimitWindow | undefined, at = Date.now()) {
  if (!win) return false
  if (win.usedPercent < 100) return false
  if (win.resetsAt === undefined) return true
  return win.resetsAt * 1000 > at
}

export function limitBlocked(snap: LimitSnapshot | undefined, at = Date.now()) {
  if (!snap) return false
  return blocked(snap.primary, at) || blocked(snap.secondary, at)
}

export function limitReset(snap: LimitSnapshot | undefined, at = Date.now()) {
  if (!snap) return
  return [snap.primary, snap.secondary]
    .filter((win): win is LimitWindow => Boolean(win && blocked(win, at) && win.resetsAt !== undefined))
    .map((win) => win.resetsAt! * 1000)
    .sort((a, b) => a - b)[0]
}

export async function fetchUsageLimits(token: string, accountId?: string) {
  const headers = new Headers({
    authorization: `Bearer ${token}`,
    originator: "opencode",
    "User-Agent": "opencode-codex",
  })
  if (accountId) headers.set("ChatGPT-Account-Id", accountId)
  const res = await fetch(CODEX_USAGE_ENDPOINT, { headers })
  if (!res.ok) throw new Error(`Failed to load Codex usage limits: ${res.status}`)
  return parseUsageLimits((await res.json()) as unknown)
}
