import { expect, test } from "bun:test"

import { AccountManager } from "../../src/accounts.js"
import { DEFAULT_LIMIT_ID, OAUTH_SENTINEL_REFRESH } from "../../src/constants.js"
import { createCodexFetch } from "../../src/fetch.js"
import { loadStore, saveStore, type Account } from "../../src/storage.js"
import { chatgptAccessToken, oauthToken } from "../support/auth.js"
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

test("account manager imports access tokens as non-refreshable accounts", async () => {
  const done = await setupTestEnv()
  const restore = installFetch((async () => {
    throw new Error("offline")
  }) as unknown as typeof fetch)
  try {
    const mgr = await AccountManager.load(client())
    const accessToken = chatgptAccessToken({ userId: "user-123", accountId: "acct-123", planType: "business" })

    const imported = await mgr.importAccessToken(accessToken, "imported")

    expect(imported).toMatchObject({
      label: "imported",
      userId: "user-123",
      accountId: "acct-123",
      planType: "business",
      accessToken,
      enabled: true,
    })
    expect(imported.refreshToken).toBeUndefined()
    expect((await loadStore()).accounts[0]?.refreshToken).toBeUndefined()
  } finally {
    restore()
    await done()
  }
})

test("account manager re-imports access tokens by stable identity", async () => {
  const done = await setupTestEnv()
  const restore = installFetch((async () => {
    throw new Error("offline")
  }) as unknown as typeof fetch)
  try {
    const mgr = await AccountManager.load(client())
    const first = chatgptAccessToken({ userId: "user-123", accountId: "acct-123", extra: { jti: "first" } })
    const second = chatgptAccessToken({ userId: "user-123", accountId: "acct-123", extra: { jti: "second" } })

    await mgr.importAccessToken(first, "first")
    await mgr.importAccessToken(second, "second")

    const saved = await loadStore()
    expect(saved.accounts).toHaveLength(1)
    expect(saved.accounts[0]).toMatchObject({ label: "second", accessToken: second, userId: "user-123", accountId: "acct-123" })
  } finally {
    restore()
    await done()
  }
})

test("account manager preserves OAuth refresh token when access token is imported for same identity", async () => {
  const done = await setupTestEnv()
  const restore = installFetch((async () => {
    throw new Error("offline")
  }) as unknown as typeof fetch)
  try {
    const mgr = await AccountManager.load(client())
    await mgr.add(oauthToken({ userId: "user-123", accountId: "acct-123", refreshToken: "keep-refresh" }), "oauth")

    const imported = chatgptAccessToken({ userId: "user-123", accountId: "acct-123", extra: { jti: "imported" } })
    await mgr.importAccessToken(imported, "imported")

    const saved = await loadStore()
    expect(saved.accounts).toHaveLength(1)
    expect(saved.accounts[0]).toMatchObject({ label: "imported", accessToken: imported, refreshToken: "keep-refresh" })
  } finally {
    restore()
    await done()
  }
})

test("account manager skips auth seeding from access-token sentinel refresh", async () => {
  const done = await setupTestEnv()
  try {
    const mgr = await AccountManager.load(client())

    await mgr.ensureFromAuth({ type: "oauth", refresh: OAUTH_SENTINEL_REFRESH, access: "access", expires: Date.now() + 3600_000 })

    expect((await loadStore()).accounts).toHaveLength(0)
  } finally {
    await done()
  }
})

test("account manager disables expired non-refreshable accounts without OAuth refresh", async () => {
  const done = await setupTestEnv()
  const calls: string[] = []
  const restore = installFetch((async (input: Parameters<typeof fetch>[0]) => {
    calls.push(String(input))
    throw new Error("unexpected fetch")
  }) as unknown as typeof fetch)
  try {
    await saveStore({
      version: 1,
      activeIndex: 0,
      accounts: [account("expired", {}, DEFAULT_LIMIT_ID, { refreshToken: undefined, tokenExpires: Date.now() - 60_000 })],
    })
    const mgr = await AccountManager.load(client())

    let error: unknown
    try {
      await mgr.refresh(0, false)
    } catch (err) {
      error = err
    }

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("Re-import a fresh ChatGPT access token")
    expect(calls).toEqual([])
    expect((await loadStore()).accounts[0]?.enabled).toBe(false)
  } finally {
    restore()
    await done()
  }
})

test("codex fetch skips expired non-refreshable accounts when another account is available", async () => {
  const done = await setupTestEnv()
  const calls: string[] = []
  const restore = installFetch((async (input, init) => {
    calls.push(String(input))
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer ready-access")
    expect(headers.get("ChatGPT-Account-Id")).toBe("acct-ready")
    return new Response("ok", { status: 200 })
  }) as typeof fetch)
  try {
    await saveStore({
      version: 1,
      activeIndex: 0,
      accounts: [
        account("expired", freshLimits(), DEFAULT_LIMIT_ID, { refreshToken: undefined, accessToken: "expired-access", accountId: "acct-expired", tokenExpires: Date.now() - 60_000 }),
        account("ready", freshLimits(), DEFAULT_LIMIT_ID, { accessToken: "ready-access", accountId: "acct-ready" }),
      ],
    })
    const mgr = await AccountManager.load(client())

    const res = await createCodexFetch(mgr)("https://api.openai.com/v1/responses", { method: "POST", body: "{}" })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe("ok")
    expect(calls).toEqual(["https://chatgpt.com/backend-api/codex/responses"])
    const saved = await loadStore()
    expect(saved.accounts[0]?.enabled).toBe(false)
    expect(saved.activeIndex).toBe(1)
  } finally {
    restore()
    await done()
  }
})

test("codex fetch disables unauthorized non-refreshable accounts without OAuth refresh", async () => {
  const done = await setupTestEnv()
  const calls: string[] = []
  const restore = installFetch((async (input, init) => {
    calls.push(String(input))
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer imported-access")
    expect(headers.get("ChatGPT-Account-Id")).toBe("acct-123")
    return new Response("unauthorized", { status: 401 })
  }) as typeof fetch)
  try {
    await saveStore({
      version: 1,
      activeIndex: 0,
      accounts: [account("imported", freshLimits(), DEFAULT_LIMIT_ID, { refreshToken: undefined, accessToken: "imported-access", accountId: "acct-123" })],
    })
    const mgr = await AccountManager.load(client())

    let error: unknown
    try {
      await createCodexFetch(mgr)("https://api.openai.com/v1/responses", { method: "POST", body: "{}" })
    } catch (err) {
      error = err
    }

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("Re-import a fresh ChatGPT access token")
    expect(calls).toEqual(["https://chatgpt.com/backend-api/codex/responses"])
    expect((await loadStore()).accounts[0]?.enabled).toBe(false)
  } finally {
    restore()
    await done()
  }
})
