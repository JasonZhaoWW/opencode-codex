import { DEFAULT_LIMIT_ID, CODEX_API_ENDPOINT } from "./constants.js"
import { limitReset, normalizeLimitId, parseLimitFailure, parseLimitHeaders } from "./limits.js"
import { accessExpired } from "./oauth.js"
import { AccountManager } from "./accounts.js"

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

function wrap(res: Response, index: number, mgr: AccountManager) {
  const limits = parseLimitHeaders(res.headers)
  if (Object.keys(limits).length > 0) mgr.captureLimits(index, limits, undefined, true)
  return res
}

async function send(mgr: AccountManager, req: Awaited<ReturnType<typeof normalize>>, skip = -1) {
  const sel = await mgr.select(skip)
  if (accessExpired(sel.account.tokenExpires)) await mgr.refresh(sel.index)
  const headers = withHeaders(req.init.headers)
  headers.set("authorization", `Bearer ${sel.account.accessToken}`)
  if (sel.account.accountId) headers.set("ChatGPT-Account-Id", sel.account.accountId)
  const res = await fetch(rewrite(req.url), {
    ...req.init,
    headers,
  })
  return { res, sel }
}

export function createCodexFetch(mgr: AccountManager) {
  return async function codexFetch(input: RequestInfo | URL, init?: RequestInit) {
    if (!isCodexRequest(input)) return fetch(input, init)
    const req = await normalize(input, init)
    const first = await send(mgr, req)
    if (first.res.status !== 429) return wrap(first.res, first.sel.index, mgr)
    const firstFail = parseLimitFailure(first.res.headers)
    if (Object.keys(firstFail.limits).length > 0) mgr.captureLimits(first.sel.index, firstFail.limits, firstFail.activeLimitId)
    const firstId = normalizeLimitId(firstFail.activeLimitId || first.sel.account.activeLimitId || DEFAULT_LIMIT_ID)
    const firstSnap = firstFail.limits[firstId] || firstFail.limits[DEFAULT_LIMIT_ID]
    if (!firstSnap || limitReset(firstSnap) === undefined) mgr.markRateLimited(first.sel.index, firstFail.resetAt, firstId)
    const second = await send(mgr, req, first.sel.index).catch(() => undefined)
    if (!second) throw new Error("All accounts are rate-limited.")
    if (second.res.status === 429) {
      const secondFail = parseLimitFailure(second.res.headers)
      if (Object.keys(secondFail.limits).length > 0) mgr.captureLimits(second.sel.index, secondFail.limits, secondFail.activeLimitId)
      const secondId = normalizeLimitId(secondFail.activeLimitId || second.sel.account.activeLimitId || DEFAULT_LIMIT_ID)
      const secondSnap = secondFail.limits[secondId] || secondFail.limits[DEFAULT_LIMIT_ID]
      if (!secondSnap || limitReset(secondSnap) === undefined) mgr.markRateLimited(second.sel.index, secondFail.resetAt, secondId)
      throw new Error("All accounts are rate-limited.")
    }
    return wrap(second.res, second.sel.index, mgr)
  }
}
