import { expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"

import { CodexMultiAuthPlugin } from "../../src/plugin.js"
import { setupTestEnv } from "../support/env.js"
import { installFetch } from "../support/fetch.js"
import { client } from "../support/fixtures.js"

test("plugin exposes Codex and API key auth methods", async () => {
  const hooks = await CodexMultiAuthPlugin({
    client: client(),
    worktree: process.cwd(),
  } as PluginInput)

  expect(hooks.auth?.methods.map((x) => ({ label: x.label, type: x.type }))).toEqual([
    { label: "Codex", type: "oauth" },
    { label: "Manually enter API Key", type: "api" },
  ])
})

test("oauth auth loader still returns codex transport options without replacing models", async () => {
  const done = await setupTestEnv()
  const restore = installFetch((async () => {
    throw new Error("offline")
  }) as unknown as typeof fetch)
  try {
    const hooks = await CodexMultiAuthPlugin({
      client: client(),
      worktree: process.cwd(),
    } as PluginInput)

    const provider = {
      models: {
        junk: {},
      },
    }

    const out = await hooks.auth?.loader?.(
      async () => ({ type: "oauth", refresh: "r", access: "a", expires: Date.now() + 60_000 }),
      provider as never,
    )

    expect(out?.apiKey).toBeDefined()
    expect(Object.keys(provider.models)).toEqual(["junk"])
  } finally {
    restore()
    await done()
  }
})
