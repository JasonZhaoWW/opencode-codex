import { expect, test } from "bun:test"

import { AccountManager } from "../../src/accounts.js"
import { CODEX_API_ENDPOINT, DEFAULT_LIMIT_ID } from "../../src/constants.js"
import { createCodexFetch } from "../../src/fetch.js"
import { loadStore, saveStore, type Account } from "../../src/storage.js"
import { setupTestEnv } from "../support/env.js"
import { installFetch } from "../support/fetch.js"
import { account, client } from "../support/fixtures.js"

function freshLimits(): Account["limits"] {
  return {
    codex: {
      capturedAt: Date.now(),
      primary: { usedPercent: 1, windowMinutes: 300, resetsAt: Math.trunc(Date.now() / 1000) + 600 },
    },
  }
}

test("codex fetch uses refreshed access token for the request that triggered refresh", async () => {
  const done = await setupTestEnv()
  const calls: string[] = []
  const restore = installFetch((async (input, init) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith("/oauth/token")) {
      expect(String(init?.body)).toContain("refresh_token=expired-refresh")
      return new Response(
        JSON.stringify({
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }

    expect(url).toBe(CODEX_API_ENDPOINT)
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer fresh-access")
    expect(headers.get("ChatGPT-Account-Id")).toBe("acct_123")
    return new Response("ok", { status: 200 })
  }) as typeof fetch)
  try {
    await saveStore({
      version: 1,
      activeIndex: 0,
      accounts: [account("expired", freshLimits(), DEFAULT_LIMIT_ID, { accountId: "acct_123", tokenExpires: Date.now() - 60_000 })],
    })

    const mgr = await AccountManager.load(client())
    const codexFetch = createCodexFetch(mgr)
    const res = await codexFetch("https://api.openai.com/v1/responses", { method: "POST", body: "{}" })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe("ok")
    expect(calls).toEqual(["https://auth.openai.com/oauth/token", CODEX_API_ENDPOINT])
    expect((await loadStore()).accounts[0]).toMatchObject({ accessToken: "fresh-access", refreshToken: "fresh-refresh" })
  } finally {
    restore()
    await done()
  }
})

test("codex fetch refreshes and retries once after unauthorized response", async () => {
  const done = await setupTestEnv()
  const codexAuthorizations: Array<string | null> = []
  let refreshCalls = 0
  const restore = installFetch((async (input, init) => {
    const url = String(input)
    if (url.endsWith("/oauth/token")) {
      refreshCalls++
      expect(String(init?.body)).toContain("refresh_token=ready-refresh")
      return new Response(
        JSON.stringify({
          access_token: "recovered-access",
          refresh_token: "recovered-refresh",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }

    expect(url).toBe(CODEX_API_ENDPOINT)
    codexAuthorizations.push(new Headers(init?.headers).get("authorization"))
    return new Response(codexAuthorizations.length === 1 ? "unauthorized" : "recovered", {
      status: codexAuthorizations.length === 1 ? 401 : 200,
    })
  }) as typeof fetch)
  try {
    await saveStore({
      version: 1,
      activeIndex: 0,
      accounts: [account("ready", freshLimits(), DEFAULT_LIMIT_ID, { accountId: "acct_123" })],
    })

    const mgr = await AccountManager.load(client())
    const res = await createCodexFetch(mgr)("https://api.openai.com/v1/responses", { method: "POST", body: "{}" })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe("recovered")
    expect(refreshCalls).toBe(1)
    expect(codexAuthorizations).toEqual(["Bearer ready-access", "Bearer recovered-access"])
  } finally {
    restore()
    await done()
  }
})

test("codex fetch returns second unauthorized response without another refresh", async () => {
  const done = await setupTestEnv()
  const codexAuthorizations: Array<string | null> = []
  let refreshCalls = 0
  const restore = installFetch((async (input, init) => {
    const url = String(input)
    if (url.endsWith("/oauth/token")) {
      refreshCalls++
      return new Response(
        JSON.stringify({
          access_token: "retry-access",
          refresh_token: "retry-refresh",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }

    expect(url).toBe(CODEX_API_ENDPOINT)
    codexAuthorizations.push(new Headers(init?.headers).get("authorization"))
    return new Response("unauthorized", { status: 401 })
  }) as typeof fetch)
  try {
    await saveStore({
      version: 1,
      activeIndex: 0,
      accounts: [account("ready", freshLimits(), DEFAULT_LIMIT_ID, { accountId: "acct_123" })],
    })

    const mgr = await AccountManager.load(client())
    const res = await createCodexFetch(mgr)("https://api.openai.com/v1/responses", { method: "POST", body: "{}" })

    expect(res.status).toBe(401)
    expect(await res.text()).toBe("unauthorized")
    expect(refreshCalls).toBe(1)
    expect(codexAuthorizations).toEqual(["Bearer ready-access", "Bearer retry-access"])
  } finally {
    restore()
    await done()
  }
})

test("codex fetch still fails over to the next account after rate limit", async () => {
  const done = await setupTestEnv()
  const codexAuthorizations: Array<string | null> = []
  const restore = installFetch((async (input, init) => {
    expect(String(input)).toBe(CODEX_API_ENDPOINT)
    codexAuthorizations.push(new Headers(init?.headers).get("authorization"))
    if (codexAuthorizations.length === 1) return new Response("limited", { status: 429, headers: { "Retry-After": "60" } })
    return new Response("ok", { status: 200 })
  }) as typeof fetch)
  try {
    await saveStore({
      version: 1,
      activeIndex: 0,
      accounts: [
        account("blue", freshLimits(), DEFAULT_LIMIT_ID, { accountId: "acct_blue" }),
        account("red", freshLimits(), DEFAULT_LIMIT_ID, { accountId: "acct_red" }),
      ],
    })

    const mgr = await AccountManager.load(client())
    const res = await createCodexFetch(mgr)("https://api.openai.com/v1/responses", { method: "POST", body: "{}" })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe("ok")
    expect(codexAuthorizations).toEqual(["Bearer blue-access", "Bearer red-access"])
  } finally {
    restore()
    await done()
  }
})

test("codex fetch uses imported access-token accounts for requests", async () => {
  const done = await setupTestEnv()
  const restore = installFetch((async (input, init) => {
    expect(String(input)).toBe(CODEX_API_ENDPOINT)
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer imported-access")
    expect(headers.get("ChatGPT-Account-Id")).toBe("acct_imported")
    return new Response("ok", { status: 200 })
  }) as typeof fetch)
  try {
    await saveStore({
      version: 1,
      activeIndex: 0,
      accounts: [account("imported", freshLimits(), DEFAULT_LIMIT_ID, { refreshToken: undefined, accessToken: "imported-access", accountId: "acct_imported" })],
    })

    const mgr = await AccountManager.load(client())
    const res = await createCodexFetch(mgr)("https://api.openai.com/v1/responses", { method: "POST", body: "{}" })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe("ok")
  } finally {
    restore()
    await done()
  }
})

test("codex fetch can fail over from rate-limited imported accounts", async () => {
  const done = await setupTestEnv()
  const authorizations: Array<string | null> = []
  const restore = installFetch((async (input, init) => {
    expect(String(input)).toBe(CODEX_API_ENDPOINT)
    authorizations.push(new Headers(init?.headers).get("authorization"))
    if (authorizations.length === 1) return new Response("limited", { status: 429, headers: { "Retry-After": "60" } })
    return new Response("ok", { status: 200 })
  }) as typeof fetch)
  try {
    await saveStore({
      version: 1,
      activeIndex: 0,
      accounts: [
        account("imported", freshLimits(), DEFAULT_LIMIT_ID, { refreshToken: undefined, accessToken: "imported-access", accountId: "acct_imported" }),
        account("oauth", freshLimits(), DEFAULT_LIMIT_ID, { accessToken: "oauth-access", accountId: "acct_oauth" }),
      ],
    })

    const mgr = await AccountManager.load(client())
    const res = await createCodexFetch(mgr)("https://api.openai.com/v1/responses", { method: "POST", body: "{}" })

    expect(res.status).toBe(200)
    expect(authorizations).toEqual(["Bearer imported-access", "Bearer oauth-access"])
  } finally {
    restore()
    await done()
  }
})
