import { expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"

import { getAccountsDbPath, loadStore, releaseRefreshLock, tryAcquireRefreshLock } from "../../src/storage.js"
import { setupTestEnv } from "../support/env.js"

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
