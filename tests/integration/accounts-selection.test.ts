import { expect, test } from "bun:test"

import { AccountManager } from "../../src/accounts.js"
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
