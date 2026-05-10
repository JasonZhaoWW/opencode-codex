import { expect, test } from "bun:test"

import { AccountManager } from "../../src/accounts.js"
import { DEFAULT_LIMIT_ID } from "../../src/constants.js"
import { loadStore, saveStore } from "../../src/storage.js"
import { setupTestEnv } from "../support/env.js"
import { account, client } from "../support/fixtures.js"

test("select skips accounts exhausted by primary and secondary windows", async () => {
  const done = await setupTestEnv()
  try {
    await saveStore({
      version: 1,
      activeIndex: 0,
      accounts: [
        account("five-hour", {
          codex: {
            capturedAt: Date.now(),
            primary: { usedPercent: 100, windowMinutes: 300, resetsAt: Math.trunc(Date.now() / 1000) + 600 },
          },
        }),
        account("weekly", {
          codex: {
            capturedAt: Date.now(),
            secondary: { usedPercent: 100, windowMinutes: 10080, resetsAt: Math.trunc(Date.now() / 1000) + 1200 },
          },
        }),
        account("ready", {
          codex: {
            capturedAt: Date.now(),
            primary: { usedPercent: 40, windowMinutes: 300, resetsAt: Math.trunc(Date.now() / 1000) + 600 },
            secondary: { usedPercent: 15, windowMinutes: 10080, resetsAt: Math.trunc(Date.now() / 1000) + 1200 },
          },
        }),
      ],
    })

    const mgr = await AccountManager.load(client())
    const sel = await mgr.select()
    const saved = await loadStore()

    expect(sel.index).toBe(2)
    expect(sel.account.label).toBe("ready")
    expect(saved.activeIndex).toBe(2)
    expect(saved.accounts[2]?.lastUsed).toBeGreaterThan(0)
  } finally {
    await done()
  }
})

test("setCurrent persists an available account as current", async () => {
  const done = await setupTestEnv()
  try {
    await saveStore({
      version: 1,
      activeIndex: 0,
      accounts: [account("blue", {}), account("red", {})],
    })

    const mgr = await AccountManager.load(client())
    await expect(mgr.setCurrent(1)).resolves.toBe(true)

    const saved = await loadStore()
    expect(saved.activeIndex).toBe(1)
    expect(saved.accounts[1]?.label).toBe("red")
  } finally {
    await done()
  }
})

test("stale setCurrent resolves selected account against latest store", async () => {
  const done = await setupTestEnv()
  try {
    await saveStore({
      version: 1,
      activeIndex: 0,
      accounts: [
        account("blue", {}, DEFAULT_LIMIT_ID, { userId: "user-blue", accountId: "acct-blue" }),
        account("red", {}, DEFAULT_LIMIT_ID, { userId: "user-red", accountId: "acct-red" }),
        account("green", {}, DEFAULT_LIMIT_ID, { userId: "user-green", accountId: "acct-green" }),
      ],
    })

    const stale = await AccountManager.load(client())
    const first = await AccountManager.load(client())
    await first.remove(0)

    await expect(stale.setCurrent(2)).resolves.toBe(true)

    const saved = await loadStore()
    expect(saved.accounts.map((item) => item.label)).toEqual(["red", "green"])
    expect(saved.activeIndex).toBe(1)
  } finally {
    await done()
  }
})

test("setCurrent rejects disabled and known rate-limited accounts", async () => {
  const done = await setupTestEnv()
  try {
    await saveStore({
      version: 1,
      activeIndex: 0,
      accounts: [
        account("ready", {}),
        account("disabled", {}, DEFAULT_LIMIT_ID, { enabled: false }),
        account("limited", {
          codex: {
            capturedAt: Date.now(),
            primary: { usedPercent: 100, windowMinutes: 300, resetsAt: Math.trunc(Date.now() / 1000) + 600 },
          },
        }),
      ],
    })

    const mgr = await AccountManager.load(client())

    await expect(mgr.setCurrent(1)).resolves.toBe(false)
    await expect(mgr.setCurrent(2)).resolves.toBe(false)

    const saved = await loadStore()
    expect(saved.activeIndex).toBe(0)
    expect(saved.accounts[0]?.label).toBe("ready")
  } finally {
    await done()
  }
})
