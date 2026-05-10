import { expect, test } from "bun:test"

import { AccountManager } from "../../src/accounts.js"
import { DEFAULT_LIMIT_ID } from "../../src/constants.js"
import { loadStore, saveStore } from "../../src/storage.js"
import { oauthToken } from "../support/auth.js"
import { setupTestEnv } from "../support/env.js"
import { installFetch } from "../support/fetch.js"
import { account, client, store } from "../support/fixtures.js"

test("stale manager updates preserve renamed label immediately", async () => {
  const done = await setupTestEnv()
  try {
    await saveStore({
      version: 1,
      activeIndex: 0,
      accounts: [account("before", {})],
    })

    const first = await AccountManager.load(client())
    const stale = await AccountManager.load(client())

    await stale.markRateLimited(0)
    await first.rename(0, "after")

    expect((await loadStore()).accounts[0]).toMatchObject({
      label: "after",
      rateLimitResetTime: expect.any(Number),
    })
  } finally {
    await done()
  }
})

test("direct stale snapshot saves preserve unrelated account updates", async () => {
  const done = await setupTestEnv()
  const restore = installFetch((async () => {
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
  }) as unknown as typeof fetch)
  try {
    await saveStore(store([
      account("ready", {}, DEFAULT_LIMIT_ID, { userId: "user-1", accountId: "acct-1" }),
    ]))

    const first = await AccountManager.load(client())
    const stale = await AccountManager.load(client())

    await first.toggle(0)
    await stale.quota(0)

    expect((await loadStore()).accounts[0]).toMatchObject({
      enabled: false,
      limits: {
        codex: {
          primary: { usedPercent: 42 },
        },
      },
    })
  } finally {
    restore()
    await done()
  }
})

test("stale manager add preserves concurrently added accounts", async () => {
  const done = await setupTestEnv()
  const restore = installFetch((async () => {
    throw new Error("offline")
  }) as unknown as typeof fetch)
  try {
    const first = await AccountManager.load(client())
    const stale = await AccountManager.load(client())

    await first.add(oauthToken({ userId: "user-blue", accountId: "acct-blue", refreshToken: "refresh-blue" }), "blue")
    await stale.add(oauthToken({ userId: "user-red", accountId: "acct-red", refreshToken: "refresh-red" }), "red")

    expect((await loadStore()).accounts.map((item) => item.label)).toEqual(["blue", "red"])
  } finally {
    restore()
    await done()
  }
})

test("ensureFromAuth does not add a stale primary account over a newer store", async () => {
  const done = await setupTestEnv()
  const restore = installFetch((async () => {
    throw new Error("offline")
  }) as unknown as typeof fetch)
  try {
    const stale = await AccountManager.load(client())
    const first = await AccountManager.load(client())

    await first.add(oauthToken({ userId: "user-blue", accountId: "acct-blue", refreshToken: "refresh-blue" }), "blue")
    await stale.ensureFromAuth({
      type: "oauth",
      refresh: "refresh-primary",
      access: "access-primary",
      expires: Date.now() + 60_000,
      accountId: "acct-primary",
    })

    expect((await loadStore()).accounts.map((item) => item.label)).toEqual(["blue"])
  } finally {
    restore()
    await done()
  }
})

test("stale request selection does not overwrite a newer manual current switch", async () => {
  const done = await setupTestEnv()
  let manual: AccountManager | undefined
  const restore = installFetch((async () => {
    if (!manual) throw new Error("missing manual manager")
    await manual.setCurrent(1)
    return new Response(
      JSON.stringify({
        rate_limit: {
          primary_window: {
            used_percent: 10,
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
  }) as unknown as typeof fetch)
  try {
    await saveStore({
      version: 1,
      activeIndex: 0,
      accounts: [
        account("blue", {}, DEFAULT_LIMIT_ID, { userId: "user-blue", accountId: "acct-blue" }),
        account("red", {
          codex: {
            capturedAt: Date.now(),
            primary: { usedPercent: 10, windowMinutes: 300, resetsAt: Math.trunc(Date.now() / 1000) + 600 },
          },
        }, DEFAULT_LIMIT_ID, { userId: "user-red", accountId: "acct-red" }),
      ],
    })

    const stale = await AccountManager.load(client())
    manual = await AccountManager.load(client())

    const selected = await stale.select()
    const saved = await loadStore()

    expect(selected.account.label).toBe("red")
    expect(saved.activeIndex).toBe(1)
    expect(saved.accounts[1]?.lastUsed).toBeGreaterThan(0)
  } finally {
    restore()
    await done()
  }
})
