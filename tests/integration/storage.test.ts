import { expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"

import { getAccountsDbPath, loadStore } from "../../src/storage.js"
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
