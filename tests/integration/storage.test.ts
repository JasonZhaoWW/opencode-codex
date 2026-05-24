import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { writeFile } from "node:fs/promises"

import { DEFAULT_LIMIT_ID } from "../../src/constants.js"
import { getAccountsDbPath, loadStore, releaseRefreshLock, saveStore, tryAcquireRefreshLock } from "../../src/storage.js"
import { setupTestEnv } from "../support/env.js"
import { account } from "../support/fixtures.js"

test("loadStore throws on corrupt sqlite database", async () => {
  const done = await setupTestEnv()
  try {
    await writeFile(getAccountsDbPath(), "not-a-sqlite-database", "utf8")

    let error: unknown
    try {
      await loadStore()
    } catch (err) {
      error = err
    }

    expect(error).toBeInstanceOf(Error)
  } finally {
    await done()
  }
})

test("refresh lock release only clears its own owner", async () => {
  const done = await setupTestEnv()
  try {
    expect(await tryAcquireRefreshLock("old", Date.now() - 1)).toBe(true)
    expect(await tryAcquireRefreshLock("new", Date.now() + 60_000)).toBe(true)

    await releaseRefreshLock("old")

    expect(await tryAcquireRefreshLock("third", Date.now() + 60_000)).toBe(false)
    await releaseRefreshLock("new")
    expect(await tryAcquireRefreshLock("third", Date.now() + 60_000)).toBe(true)
  } finally {
    await done()
  }
})

test("saveStore accepts accounts without refresh tokens", async () => {
  const done = await setupTestEnv()
  try {
    await saveStore({
      version: 1,
      activeIndex: 0,
      accounts: [account("imported", {}, DEFAULT_LIMIT_ID, { refreshToken: undefined })],
    })

    const saved = await loadStore()
    expect(saved.accounts[0]?.refreshToken).toBeUndefined()
  } finally {
    await done()
  }
})

test("loadStore migrates legacy non-null refresh_token column", async () => {
  const done = await setupTestEnv()
  try {
    const db = new Database(getAccountsDbPath(), { create: true })
    try {
      db.run(`
        CREATE TABLE accounts (
          id INTEGER PRIMARY KEY,
          label TEXT NOT NULL,
          email TEXT,
          plan_type TEXT,
          user_id TEXT,
          refresh_token TEXT NOT NULL,
          access_token TEXT NOT NULL,
          token_expires INTEGER NOT NULL,
          account_id TEXT,
          added_at INTEGER NOT NULL,
          last_used INTEGER NOT NULL,
          enabled INTEGER NOT NULL,
          active_limit_id TEXT NOT NULL,
          limits_json TEXT NOT NULL,
          rate_limit_reset_time INTEGER,
          position INTEGER NOT NULL UNIQUE
        )
      `)
      db.run(`
        INSERT INTO accounts (
          label,
          refresh_token,
          access_token,
          token_expires,
          added_at,
          last_used,
          enabled,
          active_limit_id,
          limits_json,
          position
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, ["oauth", "refresh", "access", Date.now() + 3600_000, Date.now(), 0, 1, DEFAULT_LIMIT_ID, "{}", 0])
    } finally {
      db.close()
    }

    const saved = await loadStore()
    expect(saved.accounts[0]).toMatchObject({ label: "oauth", refreshToken: "refresh" })

    const migrated = new Database(getAccountsDbPath())
    try {
      const info = migrated.query("PRAGMA table_info(accounts)").all() as Array<{ name: string; notnull: number }>
      expect(info.find((column) => column.name === "refresh_token")?.notnull).toBe(0)
    } finally {
      migrated.close()
    }
  } finally {
    await done()
  }
})
