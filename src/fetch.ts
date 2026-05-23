import { DEFAULT_LIMIT_ID, CODEX_API_ENDPOINT } from "./constants.js"
import { limitReset, normalizeLimitId, parseLimitFailure, parseLimitHeaders } from "./limits.js"
import { accessExpired } from "./oauth.js"
import { AccountManager } from "./accounts.js"
import type { ManagedAccount } from "./storage.js"

function withHeaders(input: HeadersInit | undefined) {
  const headers = new Headers(input)
  headers.delete("authorization")
  headers.delete("Authorization")
  return headers
}

async function normalize(input: RequestInfo | URL, init?: RequestInit) {
  const req = new Request(input, init)
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer().catch(() => undefined)
  const headers = withHeaders(req.headers)
  return {
    url: new URL(req.url),
    init: {
      method: req.method,
      headers,
      body,
      signal: init?.signal,
      redirect: req.redirect,
      keepalive: req.keepalive,
      credentials: req.credentials,
      mode: req.mode,
      referrer: req.referrer,
      referrerPolicy: req.referrerPolicy,
      integrity: req.integrity,
      cache: req.cache,
    } satisfies RequestInit,
  }
}

export function isCodexRequest(input: RequestInfo | URL) {
  const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url)
  return url.hostname.includes("api.openai.com") || url.hostname.includes("chatgpt.com")
}

function rewrite(url: URL) {
  if (url.pathname.includes("/v1/responses") || url.pathname.includes("/chat/completions")) return new URL(CODEX_API_ENDPOINT)
  return url
}

async function wrap(res: Response, index: number, mgr: AccountManager) {
  const limits = parseLimitHeaders(res.headers)
  if (Object.keys(limits).length > 0) await mgr.captureLimits(index, limits, undefined, true)
  return res
}

type NormalizedRequest = Awaited<ReturnType<typeof normalize>>

async function fetchWithAccount(req: NormalizedRequest, account: ManagedAccount) {
  const headers = withHeaders(req.init.headers)
  headers.set("authorization", `Bearer ${account.accessToken}`)
  if (account.accountId) headers.set("ChatGPT-Account-Id", account.accountId)
  return fetch(rewrite(req.url), {
    ...req.init,
    headers,
  })
}

async function send(mgr: AccountManager, req: NormalizedRequest, skip = -1) {
  const sel = await mgr.select(skip)
  const account = accessExpired(sel.account.tokenExpires)
    ? await mgr.refresh(sel.index, false)
    : sel.account
  const res = await fetchWithAccount(req, account)
  return { res, sel: { ...sel, account } }
}

async function recoverUnauthorized(mgr: AccountManager, req: NormalizedRequest, sent: Awaited<ReturnType<typeof send>>) {
  if (sent.res.status !== 401) return sent
  const account = await mgr.refresh(sent.sel.index, false, true)
  const res = await fetchWithAccount(req, account)
  return { res, sel: { ...sent.sel, account } }
}

function noFailoverAccount(err: unknown) {
  if (!(err instanceof Error)) return false
  return err.message.startsWith("All accounts are rate-limited") || err.message === "No enabled ChatGPT accounts available."
}

export function createCodexFetch(mgr: AccountManager) {
  return async function codexFetch(input: RequestInfo | URL, init?: RequestInit) {
    if (!isCodexRequest(input)) return fetch(input, init)
    const req = await normalize(input, init)
    const first = await recoverUnauthorized(mgr, req, await send(mgr, req))
    if (first.res.status !== 429) return wrap(first.res, first.sel.index, mgr)
    const firstFail = parseLimitFailure(first.res.headers)
    if (Object.keys(firstFail.limits).length > 0) await mgr.captureLimits(first.sel.index, firstFail.limits, firstFail.activeLimitId)
    const firstId = normalizeLimitId(firstFail.activeLimitId || first.sel.account.activeLimitId || DEFAULT_LIMIT_ID)
    const firstSnap = firstFail.limits[firstId] || firstFail.limits[DEFAULT_LIMIT_ID]
    if (!firstSnap || limitReset(firstSnap) === undefined) await mgr.markRateLimited(first.sel.index, firstFail.resetAt, firstId)
    let second: Awaited<ReturnType<typeof send>> | undefined
    try {
      second = await recoverUnauthorized(mgr, req, await send(mgr, req, first.sel.index))
    } catch (err) {
      if (!noFailoverAccount(err)) throw err
    }
    if (!second) throw new Error("All accounts are rate-limited.")
    if (second.res.status === 429) {
      const secondFail = parseLimitFailure(second.res.headers)
      if (Object.keys(secondFail.limits).length > 0) await mgr.captureLimits(second.sel.index, secondFail.limits, secondFail.activeLimitId)
      const secondId = normalizeLimitId(secondFail.activeLimitId || second.sel.account.activeLimitId || DEFAULT_LIMIT_ID)
      const secondSnap = secondFail.limits[secondId] || secondFail.limits[DEFAULT_LIMIT_ID]
      if (!secondSnap || limitReset(secondSnap) === undefined) await mgr.markRateLimited(second.sel.index, secondFail.resetAt, secondId)
      throw new Error("All accounts are rate-limited.")
    }
    return wrap(second.res, second.sel.index, mgr)
  }
}
