import { expect, test } from "bun:test"

import { buildAccountMenuItems, promptAccountLabel, promptLoginMenuFallback } from "../../src/cli.js"
import { DEFAULT_LIMIT_ID } from "../../src/constants.js"
import { ANSI } from "../../src/ui/ansi.js"
import { account } from "../support/fixtures.js"

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
  expect(items[0]?.detailQuotaLines[0]).not.toContain(ANSI.dim)
  expect(items[0]?.detailQuotaLines[2]).toContain("weekly")
  expect(items[0]?.detailQuotaLines[2]).toContain("95% left")
  expect(items[0]?.fallbackQuotaLines[0]).toContain("=")
})

test("buildAccountMenuItems marks current account and surfaces saved label", () => {
  const items = buildAccountMenuItems(
    [account("work", {}), account("personal", {}, DEFAULT_LIMIT_ID, { email: "person@example.com", planType: "business", lastUsed: Date.now() - 60_000 })],
    1,
  )

  expect(items[1]?.label).toBe("personal")
  expect(items[1]?.current).toBe(true)
  expect(items[1]?.secondary).toContain("plan business")
  expect(items[1]?.secondary).toContain("person@example.com")
  expect(items[1]?.menuHint).toContain("used today")
})

test("buildAccountMenuItems treats the first account as current when none is selected", () => {
  const items = buildAccountMenuItems([account("work", {}), account("personal", {})])

  expect(items[0]?.current).toBe(true)
  expect(items[1]?.current).toBe(false)
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

test("promptLoginMenuFallback returns set-current action for eligible accounts", async () => {
  const answers = ["4", "5"]
  const writes: string[] = []

  expect(
    await promptLoginMenuFallback([account("current", {}), account("ready", {})], 0, {
      ask: async () => answers.shift() || "0",
      write: (text) => {
        writes.push(text)
      },
    }),
  ).toEqual({ type: "set-current", index: 1 })
  expect(writes.join("\n")).toContain("5. Set as current account")
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

test("promptLoginMenuFallback prints status before current", async () => {
  const writes: string[] = []

  await promptLoginMenuFallback([account("ready", {})], -1, {
    ask: async () => "0",
    write: (text) => {
      writes.push(text)
    },
  })

  expect(writes.join("\n")).toContain("ready [active] [current]")
})
