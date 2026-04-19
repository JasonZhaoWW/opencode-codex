import { expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"

import { buildCodexModels } from "../../src/models.js"
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

test("plugin provider hook replaces layered openai models for oauth auth", async () => {
  const hooks = await CodexMultiAuthPlugin({
    client: client(),
    worktree: process.cwd(),
  } as PluginInput)
  const ext = hooks as typeof hooks & {
    provider?: {
      models(provider: { models: Record<string, unknown> }, ctx: { auth?: { type: string } }): Promise<Record<string, unknown>>
    }
  }

  const provider = {
    models: {
      junk: {
        id: "junk",
        providerID: "openai",
        api: { id: "junk", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
        name: "junk",
        capabilities: {
          temperature: true,
          reasoning: true,
          attachment: true,
          toolcall: true,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        cost: { input: 1, output: 1, cache: { read: 1, write: 1 } },
        limit: { context: 1, output: 1 },
        status: "active",
        options: {},
        headers: {},
        release_date: "",
        variants: {},
      },
    },
  }

  const out = await ext.provider?.models(provider, { auth: { type: "oauth" } })

  const list = out as Record<string, { name?: string; cost?: unknown }>

  expect(Object.keys(list).sort()).toEqual(Object.keys(buildCodexModels()).sort())
  expect(list["gpt-5.2"]?.name).toBe("GPT-5.2")
  expect(list["gpt-5.4"]?.cost).toEqual({
    input: 0,
    output: 0,
    cache: { read: 0, write: 0 },
  })
})

test("plugin provider hook keeps layered openai models for api auth", async () => {
  const hooks = await CodexMultiAuthPlugin({
    client: client(),
    worktree: process.cwd(),
  } as PluginInput)
  const ext = hooks as typeof hooks & {
    provider?: {
      models(provider: { models: Record<string, unknown> }, ctx: { auth?: { type: string } }): Promise<Record<string, unknown>>
    }
  }

  const provider = {
    models: {
      "gpt-5.4": { family: "gpt" },
      "gpt-5.3-codex": { family: "gpt-codex" },
    },
  }

  expect(await ext.provider?.models(provider, { auth: { type: "api" } })).toBe(provider.models)
  expect(Object.keys(provider.models)).toEqual(["gpt-5.4", "gpt-5.3-codex"])
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
