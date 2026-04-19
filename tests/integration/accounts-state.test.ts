import { expect, test } from "bun:test"

import { AccountManager } from "../../src/accounts.js"
import { DEFAULT_LIMIT_ID } from "../../src/constants.js"
import { loadStore, saveStore } from "../../src/storage.js"
import { oauthToken } from "../support/auth.js"
import { setupTestEnv } from "../support/env.js"
import { installFetch } from "../support/fetch.js"
import { account, client } from "../support/fixtures.js"

test("account manager rename updates stored label", async () => {
  const done = await setupTestEnv()
  try {
    await saveStore({
      version: 1,
      activeIndex: 0,
      accounts: [account("before", {})],
    })

    const mgr = await AccountManager.load(client())
    await mgr.rename(0, "after")

    expect((await loadStore()).accounts[0]?.label).toBe("after")
  } finally {
    await done()
  }
})

test("account manager load migrates missing user ids from tokens", async () => {
  const done = await setupTestEnv()
  try {
    await saveStore({
      version: 1,
      activeIndex: 0,
      accounts: [
        account("legacy", {}, DEFAULT_LIMIT_ID, {
          accessToken: oauthToken({ userId: "user-123", accountId: "acct-shared", organizationId: "org-blue", planType: "business" }).access_token,
        }),
      ],
    })

    await AccountManager.load(client())

    expect((await loadStore()).accounts[0]).toMatchObject({
      planType: "business",
      userId: "user-123",
      accountId: "acct-shared",
    })
  } finally {
    await done()
  }
})

test("account manager keeps same user in different workspaces separate on add", async () => {
  const done = await setupTestEnv()
  const restore = installFetch((async () => {
    throw new Error("offline")
  }) as unknown as typeof fetch)
  try {
    const mgr = await AccountManager.load(client())
    await mgr.add(oauthToken({ userId: "user-shared", accountId: "acct-blue", organizationId: "org-blue", refreshToken: "shared-refresh" }), "blue")
    await mgr.add(oauthToken({ userId: "user-shared", accountId: "acct-red", organizationId: "org-red", refreshToken: "shared-refresh" }), "red")

    expect((await loadStore()).accounts.map((item) => ({ label: item.label, userId: item.userId, accountId: item.accountId }))).toEqual([
      { label: "blue", userId: "user-shared", accountId: "acct-blue" },
      { label: "red", userId: "user-shared", accountId: "acct-red" },
    ])
  } finally {
    restore()
    await done()
  }
})

test("account manager keeps sequential renames isolated per workspace user", async () => {
  const done = await setupTestEnv()
  try {
    await saveStore({
      version: 1,
      activeIndex: 0,
      accounts: [
        account("before-one", {}, DEFAULT_LIMIT_ID, {
          userId: "user-blue",
          accountId: "workspace-team",
          refreshToken: "shared-refresh",
        }),
        account("before-two", {}, DEFAULT_LIMIT_ID, {
          userId: "user-red",
          accountId: "workspace-team",
          refreshToken: "shared-refresh",
        }),
      ],
    })

    const mgr = await AccountManager.load(client())
    await mgr.rename(0, "after-one")
    await mgr.rename(1, "after-two")

    expect((await loadStore()).accounts.map((item) => item.label)).toEqual(["after-one", "after-two"])
  } finally {
    await done()
  }
})
