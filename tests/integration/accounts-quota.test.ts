import { expect, test } from "bun:test"

import { AccountManager } from "../../src/accounts.js"
import { DEFAULT_LIMIT_ID } from "../../src/constants.js"
import { loadStore, saveStore } from "../../src/storage.js"
import { setupTestEnv } from "../support/env.js"
import { installFetch } from "../support/fetch.js"
import { account, client } from "../support/fixtures.js"

test("account manager quota refresh updates limits without rotating tokens", async () => {
  const done = await setupTestEnv()
  const restore = installFetch((async (input, init) => {
    expect(input).toBe("https://chatgpt.com/backend-api/wham/usage")
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer ready-access")
    expect(headers.get("ChatGPT-Account-Id")).toBe("acct_123")
    return new Response(
      JSON.stringify({
        rate_limit: {
          primary_window: {
            used_percent: 42,
            limit_window_seconds: 18_000,
            reset_at: 1_700_000_000,
          },
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )
  }) as typeof fetch)
  try {
    await saveStore({
      version: 1,
      activeIndex: 0,
      accounts: [account("ready", {}, DEFAULT_LIMIT_ID, { accountId: "acct_123" })],
    })

    const mgr = await AccountManager.load(client())
    await mgr.quota(0)

    const hit = (await loadStore()).accounts[0]
    expect(hit?.accessToken).toBe("ready-access")
    expect(hit?.refreshToken).toBe("ready-refresh")
    expect(hit?.limits.codex?.primary?.usedPercent).toBe(42)
  } finally {
    restore()
    await done()
  }
})

test("account manager quota refreshes expired access tokens first", async () => {
  const done = await setupTestEnv()
  const calls: string[] = []
  const restore = installFetch((async (input, init) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith("/oauth/token")) {
      expect(init?.method).toBe("POST")
      expect(String(init?.body)).toContain("grant_type=refresh_token")
      expect(String(init?.body)).toContain("refresh_token=expired-refresh")
      return new Response(
        JSON.stringify({
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          expires_in: 3600,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )
    }

    expect(url).toBe("https://chatgpt.com/backend-api/wham/usage")
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer fresh-access")
    expect(headers.get("ChatGPT-Account-Id")).toBe("acct_123")
    return new Response(
      JSON.stringify({
        rate_limit: {
          primary_window: {
            used_percent: 42,
            limit_window_seconds: 18_000,
            reset_at: 1_700_000_000,
          },
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )
  }) as typeof fetch)
  try {
    await saveStore({
      version: 1,
      activeIndex: 0,
      accounts: [account("expired", {}, DEFAULT_LIMIT_ID, { accountId: "acct_123", tokenExpires: Date.now() - 60_000 })],
    })

    const mgr = await AccountManager.load(client())
    await mgr.quota(0)

    const hit = (await loadStore()).accounts[0]
    expect(calls).toEqual([
      "https://auth.openai.com/oauth/token",
      "https://chatgpt.com/backend-api/wham/usage",
    ])
    expect(hit?.accessToken).toBe("fresh-access")
    expect(hit?.refreshToken).toBe("fresh-refresh")
    expect(hit?.limits.codex?.primary?.usedPercent).toBe(42)
  } finally {
    restore()
    await done()
  }
})

test("account manager persists rotated refresh token for later refreshes", async () => {
  const done = await setupTestEnv()
  const bodies: string[] = []
  const restore = installFetch((async (input, init) => {
    expect(String(input)).toBe("https://auth.openai.com/oauth/token")
    bodies.push(String(init?.body))
    const call = bodies.length
    return new Response(
      JSON.stringify({
        access_token: call === 1 ? "first-access" : "second-access",
        refresh_token: call === 1 ? "rotated-refresh" : "final-refresh",
        expires_in: 3600,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )
  }) as typeof fetch)
  try {
    await saveStore({
      version: 1,
      activeIndex: 0,
      accounts: [account("expired", {}, DEFAULT_LIMIT_ID, { accessToken: "expired-access", refreshToken: "old-refresh", tokenExpires: Date.now() - 60_000 })],
    })

    const mgr = await AccountManager.load(client())
    await mgr.refresh(0, false)

    const saved = await loadStore()
    saved.accounts[0]!.tokenExpires = Date.now() - 60_000
    await saveStore(saved)
    await mgr.reload()
    await mgr.refresh(0, false)

    expect(bodies[0]).toContain("refresh_token=old-refresh")
    expect(bodies[1]).toContain("refresh_token=rotated-refresh")
    expect((await loadStore()).accounts[0]).toMatchObject({ accessToken: "second-access", refreshToken: "final-refresh" })
  } finally {
    restore()
    await done()
  }
})

test("account manager quota disables expired accounts when refresh fails", async () => {
  const done = await setupTestEnv()
  const calls: string[] = []
  const restore = installFetch((async (input) => {
    const url = String(input)
    calls.push(url)
    expect(url).toBe("https://auth.openai.com/oauth/token")
    return new Response("", { status: 401 })
  }) as typeof fetch)
  try {
    await saveStore({
      version: 1,
      activeIndex: 0,
      accounts: [account("expired", {}, DEFAULT_LIMIT_ID, { accountId: "acct_123", tokenExpires: Date.now() - 60_000 })],
    })

    const mgr = await AccountManager.load(client())

    let error: unknown
    try {
      await mgr.quota(0)
    } catch (err) {
      error = err
    }

    const hit = (await loadStore()).accounts[0]
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("Your access token could not be refreshed. Please log out and sign in again.")
    expect(calls).toEqual(["https://auth.openai.com/oauth/token"])
    expect(hit?.enabled).toBe(false)
  } finally {
    restore()
    await done()
  }
})
