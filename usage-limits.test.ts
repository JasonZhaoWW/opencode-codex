import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import { AccountManager } from "./src/accounts.js"
import { buildAccountMenuItems, promptAccountLabel, promptLoginMenuFallback } from "./src/cli.js"
import { DEFAULT_LIMIT_ID } from "./src/constants.js"
import { parseLimitFailure, parseLimitHeaders, parseUsageLimits } from "./src/limits.js"
import { buildCodexModels } from "./src/models.js"
import { CodexMultiAuthPlugin } from "./src/plugin.js"
import { getAccountsPath, loadStore, saveStore, type Account } from "./src/storage.js"
import { measureMenuItemRows, visibleMenuWindow } from "./src/ui/select.js"

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "opencode-codex-"))
  const prev = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = dir
  return async () => {
    if (prev === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = prev
    await rm(dir, { force: true, recursive: true })
  }
}

function client() {
  return {
    auth: {
      set: async () => undefined,
    },
  } as unknown as PluginInput["client"]
}

function account(label: string, limits: Account["limits"], activeLimitId = DEFAULT_LIMIT_ID, extra: Partial<Account> = {}): Account {
  return {
    label,
    refreshToken: `${label}-refresh`,
    accessToken: `${label}-access`,
    tokenExpires: Date.now() + 60_000,
    addedAt: Date.now(),
    lastUsed: 0,
    enabled: true,
    activeLimitId,
    limits,
    ...extra,
  }
}

function clear(mgr: AccountManager) {
  clearTimeout((mgr as unknown as { saveTimer?: ReturnType<typeof setTimeout> }).saveTimer)
}

test("parseLimitHeaders reads default and alternate buckets", () => {
  const headers = new Headers({
    "x-codex-primary-used-percent": "72.5",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": "1704069000",
    "x-codex-secondary-used-percent": "40",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": "1704673800",
    "x-codex-other-primary-used-percent": "88",
    "x-codex-other-primary-window-minutes": "30",
    "x-codex-other-primary-reset-at": "1704063600",
    "x-codex-other-limit-name": "gpt-5.2-codex-sonic",
  })

  expect(parseLimitHeaders(headers, 1234)).toEqual({
    codex: {
      capturedAt: 1234,
      primary: { usedPercent: 72.5, windowMinutes: 300, resetsAt: 1704069000 },
      secondary: { usedPercent: 40, windowMinutes: 10080, resetsAt: 1704673800 },
    },
    codex_other: {
      capturedAt: 1234,
      limitName: "gpt-5.2-codex-sonic",
      primary: { usedPercent: 88, windowMinutes: 30, resetsAt: 1704063600 },
    },
  })
})

test("parseLimitFailure keeps active bucket and generic reset fallback", () => {
  const headers = new Headers({
    "Retry-After": "60",
    "x-codex-active-limit": "codex-other",
  })

  expect(parseLimitFailure(headers, 1000)).toEqual({
    activeLimitId: "codex_other",
    limits: {},
    resetAt: 61_000,
  })
})

test("parseUsageLimits normalizes default and additional usage buckets", () => {
  expect(
    parseUsageLimits(
      {
        rate_limit: {
          primary_window: {
            used_percent: 42,
            limit_window_seconds: 18_000,
            reset_at: 1_700_000_000,
          },
          secondary_window: {
            used_percent: 5,
            limit_window_seconds: 604_800,
            reset_at: 1_700_100_000,
          },
        },
        additional_rate_limits: [
          {
            limit_name: "codex_other",
            metered_feature: "codex_other",
            rate_limit: {
              primary_window: {
                used_percent: 88,
                limit_window_seconds: 1800,
                reset_at: 1_700_001_800,
              },
            },
          },
        ],
      },
      2222,
    ),
  ).toEqual({
    codex: {
      capturedAt: 2222,
      primary: { usedPercent: 42, windowMinutes: 300, resetsAt: 1_700_000_000 },
      secondary: { usedPercent: 5, windowMinutes: 10080, resetsAt: 1_700_100_000 },
    },
    codex_other: {
      capturedAt: 2222,
      limitName: "codex_other",
      primary: { usedPercent: 88, windowMinutes: 30, resetsAt: 1_700_001_800 },
    },
  })
})

test("loadStore migrates accounts without structured limits", async () => {
  const done = await setup()
  try {
    const old = {
      version: 1,
      activeIndex: 0,
      accounts: [
        {
          label: "legacy",
          refreshToken: "refresh",
          accessToken: "access",
          tokenExpires: 100,
          addedAt: 1,
          lastUsed: 0,
          enabled: true,
          usage: { requestCount: 3, inputTokens: 9 },
        } as Account,
      ],
    }
    await writeFile(getAccountsPath(), JSON.stringify(old), "utf8")

    expect(await loadStore()).toEqual({
      version: 1,
      activeIndex: 0,
      accounts: [
        {
          label: "legacy",
          refreshToken: "refresh",
          accessToken: "access",
          tokenExpires: 100,
          addedAt: 1,
          lastUsed: 0,
          enabled: true,
          activeLimitId: "codex",
          limits: {},
        },
      ],
    })
  } finally {
    await done()
  }
})

test("select skips accounts exhausted by primary and secondary windows", async () => {
  const done = await setup()
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
    clear(mgr)

    expect(sel.index).toBe(2)
    expect(sel.account.label).toBe("ready")
  } finally {
    await done()
  }
})

test("buildAccountMenuItems shows remaining quota", () => {
  const items = buildAccountMenuItems([
    account("ready", {
      codex: {
        capturedAt: Date.now(),
        primary: { usedPercent: 72.5, windowMinutes: 300, resetsAt: 1_700_000_000 },
        secondary: { usedPercent: 5, windowMinutes: 10080, resetsAt: 1_700_100_000 },
      },
    }),
  ])

  expect(items[0]?.quotaSummary).toContain("5h 28% left")
  expect(items[0]?.quotaSummary).toContain("weekly 95% left")
  expect(items[0]?.menuHint).toContain("5h 28%")
  expect(items[0]?.menuHint).toContain("28%")
  expect(items[0]?.menuHint).toContain("wk 95%")
  expect(items[0]?.menuHint).toContain("95%")
  expect(items[0]?.menuHint).not.toContain("resets")
  expect(items[0]?.detailLines[0]).toBe(items[0]?.secondary)
  expect(items[0]?.detailLines[1]).toContain("5h")
  expect(items[0]?.detailLines[1]).toContain("wk")
  expect(items[0]?.detailQuotaLines[0]).toContain("5h")
  expect(items[0]?.detailQuotaLines[0]).toContain("28% left")
  expect(items[0]?.detailQuotaLines[0]).toContain("█")
  expect(items[0]?.detailQuotaLines[2]).toContain("weekly")
  expect(items[0]?.detailQuotaLines[2]).toContain("95% left")
  expect(items[0]?.fallbackQuotaLines[0]).toContain("=")
})

test("buildAccountMenuItems marks current account and prefers email identity", () => {
  const items = buildAccountMenuItems(
    [account("work", {}), account("personal", {}, DEFAULT_LIMIT_ID, { email: "person@example.com", lastUsed: Date.now() - 60_000 })],
    1,
  )

  expect(items[1]?.label).toBe("person@example.com")
  expect(items[1]?.current).toBe(true)
  expect(items[1]?.secondary).toContain("label personal")
  expect(items[1]?.menuHint).toContain("used today")
})

test("promptLoginMenuFallback retries invalid top-level input", async () => {
  const answers = ["nope", "1"]
  const writes: string[] = []

  const action = await promptLoginMenuFallback([], 0, {
    ask: async (msg) => {
      writes.push(msg)
      return answers.shift() || "0"
    },
    write: (text) => {
      writes.push(text)
    },
  })

  expect(action).toEqual({ type: "add-browser" })
  expect(writes.join("\n")).toContain("Invalid choice. Enter 0, 1, 2, or an account number.")
})

test("promptLoginMenuFallback requires confirmation before removal", async () => {
  const cancelledAnswers = ["3", "4", "n", "0", "0"]
  const writes: string[] = []

  const cancelled = await promptLoginMenuFallback([account("ready", {})], 0, {
    ask: async (msg) => {
      writes.push(msg)
      return cancelledAnswers.shift() || "0"
    },
    write: (text) => {
      writes.push(text)
    },
  })

  expect(cancelled).toEqual({ type: "done" })

  const confirmedAnswers = ["3", "4", "y"]
  const confirmed = await promptLoginMenuFallback([account("ready", {})], 0, {
    ask: async () => confirmedAnswers.shift() || "0",
    write: () => undefined,
  })

  expect(confirmed).toEqual({ type: "remove", index: 0 })
  expect(writes.join("\n")).toContain("Remove ready?")
})

test("promptAccountLabel keeps current label on blank input", async () => {
  expect(
    await promptAccountLabel(
      {
        ask: async () => "",
        write: () => undefined,
      },
      "work",
    ),
  ).toBe("work")
})

test("promptLoginMenuFallback returns rename action", async () => {
  const answers = ["3", "1", "renamed"]

  expect(
    await promptLoginMenuFallback([account("ready", {})], 0, {
      ask: async () => answers.shift() || "0",
      write: () => undefined,
    }),
  ).toEqual({ type: "rename", index: 0, label: "renamed" })
})

test("promptLoginMenuFallback returns quota action", async () => {
  const answers = ["3", "3"]

  expect(
    await promptLoginMenuFallback([account("ready", {})], 0, {
      ask: async () => answers.shift() || "0",
      write: () => undefined,
    }),
  ).toEqual({ type: "quota", index: 0 })
})

test("promptLoginMenuFallback shows structured quota lines", async () => {
  const writes: string[] = []

  await promptLoginMenuFallback(
    [
      account("ready", {
        codex: {
          capturedAt: Date.now(),
          primary: { usedPercent: 72.5, windowMinutes: 300, resetsAt: 1_700_000_000 },
          secondary: { usedPercent: 5, windowMinutes: 10080, resetsAt: 1_700_100_000 },
        },
      }),
    ],
    0,
    {
      ask: async () => "0",
      write: (text) => {
        writes.push(text)
      },
    },
  )

  const output = writes.join("\n")
  expect(output).toContain("quota:")
  expect(output).toContain("5h")
  expect(output).toContain("28% left")
  expect(output).toContain("weekly")
  expect(output).toContain("95% left")
})

test("measureMenuItemRows counts detail lines", () => {
  expect(measureMenuItemRows({ label: "plain", value: "x" })).toBe(1)
  expect(measureMenuItemRows({ label: "with details", value: "x", details: ["a", "b"] })).toBe(3)
  expect(measureMenuItemRows({ label: "heading", value: "x", kind: "heading", details: ["a"] })).toBe(2)
})

test("visibleMenuWindow budgets rows for multi-line items", () => {
  const items = [
    { label: "first", value: "first" },
    { label: "second", value: "second", details: ["a", "b"] },
    { label: "third", value: "third", details: ["a", "b"] },
    { label: "fourth", value: "fourth" },
  ]

  expect(visibleMenuWindow(items, 2, 5)).toEqual({ windowStart: 2, windowEnd: 4 })
  expect(visibleMenuWindow(items, 1, 4)).toEqual({ windowStart: 0, windowEnd: 2 })
})

test("account manager rename updates stored label", async () => {
  const done = await setup()
  try {
    await saveStore({
      version: 1,
      activeIndex: 0,
      accounts: [account("before", {})],
    })

    const mgr = await AccountManager.load(client())
    await mgr.rename(0, "after")
    clear(mgr)

    expect((await loadStore()).accounts[0]?.label).toBe("after")
  } finally {
    await done()
  }
})

test("account manager quota refresh updates limits without rotating tokens", async () => {
  const done = await setup()
  const prev = globalThis.fetch
  try {
    await saveStore({
      version: 1,
      activeIndex: 0,
      accounts: [account("ready", {}, DEFAULT_LIMIT_ID, { accountId: "acct_123" })],
    })

    globalThis.fetch = (async (input, init) => {
      expect(input).toBe("https://chatgpt.com/backend-api/wham/usage")
      const headers = new Headers(init?.headers)
      expect(headers.get("authorization")).toBe("Bearer ready-access")
      expect(headers.get("ChatGPT-Account-Id")).toBe("acct_123")
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
    }) as typeof fetch

    const mgr = await AccountManager.load(client())
    await mgr.quota(0)
    clear(mgr)

    const hit = (await loadStore()).accounts[0]
    expect(hit?.accessToken).toBe("ready-access")
    expect(hit?.refreshToken).toBe("ready-refresh")
    expect(hit?.limits.codex?.primary?.usedPercent).toBe(42)
  } finally {
    globalThis.fetch = prev
    await done()
  }
})

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
  const prev = globalThis.fetch
  const hooks = await CodexMultiAuthPlugin({
    client: client(),
    worktree: process.cwd(),
  } as PluginInput)

  const provider = {
    models: {
      junk: {},
    },
  }

  try {
    globalThis.fetch = (async () => {
      throw new Error("offline")
    }) as typeof fetch

    const out = await hooks.auth?.loader?.(
      async () => ({ type: "oauth", refresh: "r", access: "a", expires: Date.now() + 60_000 }),
      provider as never,
    )

    expect(out?.apiKey).toBeDefined()
    expect(Object.keys(provider.models)).toEqual(["junk"])
  } finally {
    globalThis.fetch = prev
  }
})
