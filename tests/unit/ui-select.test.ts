import { expect, test } from "bun:test"

import { ANSI } from "../../src/ui/ansi.js"
import { measureMenuItemRows, styleDetailLine, visibleMenuWindow } from "../../src/ui/select.js"

test("styleDetailLine preserves ANSI-styled usage lines for inactive rows", () => {
  const quotaLine = `${ANSI.cyan}5h${ANSI.reset} ${ANSI.bold}83%${ANSI.reset}`

  expect(styleDetailLine(quotaLine, false)).toBe(quotaLine)
  expect(styleDetailLine("used today", false)).toBe(`${ANSI.dim}used today${ANSI.reset}`)
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
