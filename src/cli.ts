import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
import { DEFAULT_LIMIT_ID } from "./constants.js"
import { limitBlocked, limitReset, type LimitSnapshot, type LimitWindow } from "./limits.js"
import type { Account } from "./storage.js"
import { ANSI, isTTY } from "./ui/ansi.js"
import { confirm } from "./ui/confirm.js"
import { select, type MenuItem } from "./ui/select.js"

export type Item = {
  label: string
  status: string
  secondary: string
  menuHint: string
  quotaSummary: string
  detailLines: string[]
  detailQuotaLines: string[]
  fallbackQuotaLines: string[]
  current: boolean
}

export type Action =
  | { type: "add-browser" }
  | { type: "add-headless" }
  | { type: "rename"; index: number; label: string }
  | { type: "toggle"; index: number }
  | { type: "quota"; index: number }
  | { type: "remove"; index: number }
  | { type: "done" }

export type PromptIO = {
  ask?: (msg: string) => Promise<string>
  write?: (text: string) => void
}

type TopLevelChoice =
  | { type: "add-browser" }
  | { type: "add-headless" }
  | { type: "account"; index: number }
  | { type: "done" }

type AccountChoice = Action | { type: "back" }
type BarMode = "tty" | "text"

const PRIMARY_WINDOW_MINUTES = 300
const SECONDARY_WINDOW_MINUTES = 10080
const PARTIAL_BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const

function label(mins: number | undefined) {
  if (mins === undefined) return "limit"
  if (mins <= 24 * 60 + 3) return `${Math.max(1, Math.trunc((mins + 3) / 60))}h`
  if (mins <= 7 * 24 * 60 + 3) return "weekly"
  if (mins <= 30 * 24 * 60 + 3) return "monthly"
  return "annual"
}

function remain(used: number) {
  return Math.max(0, Math.min(100, 100 - used))
}

function describeLoaded(snap: LimitSnapshot | undefined) {
  if (!snap) return []
  return [snap.primary, snap.secondary].flatMap((win) => {
    if (!win) return []
    const out = [`${label(win.windowMinutes)} ${Math.round(remain(win.usedPercent))}% left`]
    if (win.resetsAt) out.push(`resets ${new Date(win.resetsAt * 1000).toLocaleString()}`)
    return [out.join(" ")]
  })
}

function shortLabel(mins: number | undefined) {
  if (mins === undefined) return "limit"
  if (mins <= 24 * 60 + 3) return `${Math.max(1, Math.trunc((mins + 3) / 60))}h`
  if (mins <= 7 * 24 * 60 + 3) return "wk"
  if (mins <= 30 * 24 * 60 + 3) return "mo"
  return "yr"
}

function tone(percent: number | undefined) {
  if (percent === undefined) return ANSI.dim
  if (percent < 30) return ANSI.red
  if (percent < 60) return ANSI.yellow
  return ANSI.green
}

function percentText(percent: number | undefined, long = false) {
  if (percent === undefined) return long ? "not loaded" : "n/a"
  return long ? `${percent}% left` : `${percent}%`
}

function progressBar(percent: number | undefined, width: number, mode: BarMode) {
  if (mode === "text") {
    const filled = percent === undefined ? 0 : Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
    return `[${"=".repeat(filled)}${".".repeat(width - filled)}]`
  }

  const clamped = percent === undefined ? undefined : Math.max(0, Math.min(100, percent))
  const scaled = clamped === undefined ? 0 : (clamped / 100) * width
  let full = Math.floor(scaled)
  let partial = Math.round((scaled - full) * 8)
  if (partial === 8) {
    full += 1
    partial = 0
  }
  full = Math.min(width, full)
  const usedCells = Math.min(width, full + (partial > 0 ? 1 : 0))
  const filled = `${"█".repeat(full)}${PARTIAL_BLOCKS[partial]}`
  const empty = "░".repeat(width - usedCells)
  if (clamped === undefined) return `${ANSI.dim}${empty}${ANSI.reset}`
  return `${tone(clamped)}${filled}${ANSI.reset}${ANSI.dim}${empty}${ANSI.reset}`
}

function compactUsageSummary(win: LimitWindow | undefined, fallbackMinutes: number) {
  const percent = win ? Math.round(remain(win.usedPercent)) : undefined
  return `${shortLabel(win?.windowMinutes ?? fallbackMinutes)} ${percentText(percent)}`
}

function windowCompact(win: LimitWindow | undefined, fallbackMinutes: number, mode: BarMode, width: number) {
  const percent = win ? Math.round(remain(win.usedPercent)) : undefined
  const name = `${ANSI.cyan}${shortLabel(win?.windowMinutes ?? fallbackMinutes)}${ANSI.reset}`
  const amount = `${ANSI.bold}${percentText(percent).padStart(4)}${ANSI.reset}`
  return `${name} ${amount} ${progressBar(percent, width, mode)}`
}

function windowDetail(win: LimitWindow | undefined, fallbackMinutes: number, mode: BarMode, width: number) {
  const percent = win ? Math.round(remain(win.usedPercent)) : undefined
  const name = `${ANSI.cyan}${label(win?.windowMinutes ?? fallbackMinutes).padEnd(7)}${ANSI.reset}`
  const amount = percent === undefined ? `${ANSI.dim}${percentText(percent, true)}${ANSI.reset}` : `${ANSI.bold}${percentText(percent, true)}${ANSI.reset}`
  return `${name} ${progressBar(percent, width, mode)} ${amount}`
}

function resetLine(win: LimitWindow | undefined) {
  if (!win?.resetsAt) return
  return `resets ${new Date(win.resetsAt * 1000).toLocaleString()}`
}

function extraQuotaLines(acc: Account) {
  return Object.entries(acc.limits).flatMap(([id, snap]) => {
    if (id === DEFAULT_LIMIT_ID) return []
    const name = snap.limitName || id
    return [snap.primary, snap.secondary].flatMap((win) => {
      if (!win) return []
      const lines = [`${name} ${label(win.windowMinutes)} ${Math.round(remain(win.usedPercent))}% left`]
      const reset = resetLine(win)
      if (reset) lines.push(`  ${reset}`)
      return lines
    })
  })
}

function relativeTime(timestamp: number) {
  const days = Math.floor((Date.now() - timestamp) / 86_400_000)
  if (days <= 0) return "today"
  if (days === 1) return "yesterday"
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  return new Date(timestamp).toLocaleDateString()
}

function writer(io?: PromptIO) {
  return io?.write ?? ((text: string) => process.stdout.write(text))
}

export function buildAccountMenuItems(accounts: Account[], activeIndex = -1): Item[] {
  return accounts.map((acc, index) => {
    const displayLabel = acc.label || acc.email || "account"
    const active = acc.limits[acc.activeLimitId] || acc.limits[DEFAULT_LIMIT_ID]
    const base = acc.limits[DEFAULT_LIMIT_ID]
    const status =
      acc.enabled === false
        ? "disabled"
        : (acc.rateLimitResetTime && acc.rateLimitResetTime > Date.now()) || limitBlocked(active)
          ? "rate-limited"
          : "active"
    const summaryBase = describeLoaded(base)
    const extra = Object.entries(acc.limits).flatMap(([id, snap]) => {
      if (id === DEFAULT_LIMIT_ID) return []
      const hit = describeLoaded(snap)
      if (hit.length === 0) return []
      return [`${snap.limitName || id} ${hit.join(" / ")}`]
    })
    const quotaSummary = [...summaryBase, ...extra].join(" | ") || "quota not loaded yet"
    const nextReset = (() => {
      if (acc.rateLimitResetTime && acc.rateLimitResetTime > Date.now()) return acc.rateLimitResetTime
      return limitReset(active, Date.now())
    })()
    const secondary = [
      acc.email && acc.email !== displayLabel ? acc.email : undefined,
      acc.lastUsed > 0 ? `used ${relativeTime(acc.lastUsed)}` : "never used",
      status === "rate-limited" && nextReset ? `next ${new Date(nextReset).toLocaleTimeString()}` : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" | ")
    const usageLine = [
      windowCompact(base?.primary, PRIMARY_WINDOW_MINUTES, "tty", 10),
      windowCompact(base?.secondary, SECONDARY_WINDOW_MINUTES, "tty", 10),
    ].join(` ${ANSI.dim}·${ANSI.reset} `)
    const menuHint = [
      secondary,
      compactUsageSummary(base?.primary, PRIMARY_WINDOW_MINUTES),
      compactUsageSummary(base?.secondary, SECONDARY_WINDOW_MINUTES),
    ]
      .filter((value): value is string => Boolean(value))
      .join(" | ")
    const detailQuotaLines = [
      windowDetail(base?.primary, PRIMARY_WINDOW_MINUTES, "tty", 16),
      resetLine(base?.primary) ? `  ${resetLine(base?.primary)}` : undefined,
      windowDetail(base?.secondary, SECONDARY_WINDOW_MINUTES, "tty", 16),
      resetLine(base?.secondary) ? `  ${resetLine(base?.secondary)}` : undefined,
      ...extraQuotaLines(acc),
    ].filter((value): value is string => Boolean(value))
    const fallbackQuotaLines = [
      windowDetail(base?.primary, PRIMARY_WINDOW_MINUTES, "text", 12),
      resetLine(base?.primary) ? `  ${resetLine(base?.primary)}` : undefined,
      windowDetail(base?.secondary, SECONDARY_WINDOW_MINUTES, "text", 12),
      resetLine(base?.secondary) ? `  ${resetLine(base?.secondary)}` : undefined,
      ...extraQuotaLines(acc),
    ].filter((value): value is string => Boolean(value))
    return {
      label: displayLabel,
      status,
      secondary,
      menuHint,
      quotaSummary,
      detailLines: [secondary, usageLine].filter((value): value is string => Boolean(value)),
      detailQuotaLines,
      fallbackQuotaLines,
      current: index === activeIndex,
    }
  })
}

async function ask(msg: string, io?: PromptIO) {
  if (io?.ask) return io.ask(msg)
  const rl = createInterface({ input, output })
  try {
    return (await rl.question(msg)).trim()
  } finally {
    rl.close()
  }
}

async function confirmFallback(message: string, io?: PromptIO) {
  const value = (await ask(`${message} [y/N]: `, io)).toLowerCase()
  return value === "y" || value === "yes"
}

function statusBadge(item: Item) {
  if (item.status === "active") return `${ANSI.green}[active]${ANSI.reset}`
  if (item.status === "rate-limited") return `${ANSI.yellow}[rate-limited]${ANSI.reset}`
  return `${ANSI.red}[disabled]${ANSI.reset}`
}

function summary(accounts: Account[], items: Item[], activeIndex: number) {
  const enabled = accounts.filter((account) => account.enabled !== false).length
  const rateLimited = items.filter((item) => item.status === "rate-limited").length
  const current = items[activeIndex]?.label || "none"
  return `${enabled} enabled | ${rateLimited} rate-limited | current: ${current}`
}

async function promptAccountDetailsTty(accounts: Account[], items: Item[], index: number): Promise<AccountChoice> {
  const account = accounts[index]
  const item = items[index]
  if (!account || !item) return { type: "back" }
  while (true) {
    const choice = await select<AccountChoice>(
      [
        { label: "Back", value: { type: "back" } },
        { label: "", value: { type: "back" }, separator: true },
        { label: "Usage", value: { type: "back" }, kind: "heading", details: item.detailQuotaLines },
        { label: "", value: { type: "back" }, separator: true },
        { label: "Actions", value: { type: "back" }, kind: "heading" },
        { label: "Edit label", value: { type: "rename", index, label: account.label }, color: "cyan" },
        {
          label: account.enabled === false ? "Enable account" : "Disable account",
          value: { type: "toggle", index },
          color: account.enabled === false ? "green" : "yellow",
        },
        { label: "Refresh quota", value: { type: "quota", index }, color: "cyan" },
        { label: "Remove account", value: { type: "remove", index }, color: "red" },
      ],
      {
        message: `${item.label}${item.current ? ` ${ANSI.cyan}[current]${ANSI.reset}` : ""} ${statusBadge(item)}`,
        subtitle: item.secondary,
        clearScreen: true,
      },
    )
    if (!choice || choice.type === "back") return { type: "back" }
    if (choice.type === "remove" && !(await confirm(`Remove ${item.label}?`))) continue
    if (choice.type === "rename") return { type: "rename", index, label: await promptAccountLabel(undefined, account.label) }
    return choice
  }
}

async function promptLoginMenuTty(accounts: Account[], activeIndex: number): Promise<Action> {
  while (true) {
    const items = buildAccountMenuItems(accounts, activeIndex)
    const menu: MenuItem<TopLevelChoice>[] = [
      { label: "Actions", value: { type: "done" }, kind: "heading" },
      { label: "Add account (browser)", value: { type: "add-browser" }, color: "cyan" },
      { label: "Add account (headless)", value: { type: "add-headless" }, color: "cyan" },
      { label: "", value: { type: "done" }, separator: true },
      { label: "Accounts", value: { type: "done" }, kind: "heading" },
      ...items.map((item, index) => ({
        label: `${item.label}${item.current ? ` ${ANSI.cyan}[current]${ANSI.reset}` : ""} ${statusBadge(item)}`,
        details: item.detailLines,
        value: { type: "account" as const, index },
      })),
      { label: "", value: { type: "done" }, separator: true },
      { label: "Done", value: { type: "done" } },
    ]
    const choice = await select<TopLevelChoice>(menu, {
      message: "Manage ChatGPT accounts",
      subtitle: summary(accounts, items, activeIndex),
      clearScreen: true,
    })
    if (!choice || choice.type === "done") return { type: "done" }
    if (choice.type === "add-browser" || choice.type === "add-headless") return choice
    const next = await promptAccountDetailsTty(accounts, items, choice.index)
    if (next.type === "back") continue
    return next
  }
}

async function promptAccountDetailsFallback(accounts: Account[], items: Item[], index: number, io?: PromptIO): Promise<AccountChoice> {
  const account = accounts[index]
  const item = items[index]
  if (!account || !item) return { type: "back" }
  const write = writer(io)
  while (true) {
    write(
      [
        `${item.label}${item.current ? " [current]" : ""} [${item.status}]`,
        `  ${item.secondary}`,
        "  quota:",
        ...item.fallbackQuotaLines.map((line) => `    ${line}`),
        "  1. Edit label",
        `  2. ${account.enabled === false ? "Enable" : "Disable"} account`,
        "  3. Refresh quota",
        "  4. Remove account",
        "  0. Back",
      ].join("\n") + "\n",
    )
    const value = await ask("Choice: ", io)
    if (value === "0" || value === "") return { type: "back" }
    if (value === "1") return { type: "rename", index, label: await promptAccountLabel(io, account.label) }
    if (value === "2") return { type: "toggle", index }
    if (value === "3") return { type: "quota", index }
    if (value === "4") {
      if (await confirmFallback(`Remove ${item.label}?`, io)) return { type: "remove", index }
      continue
    }
    write("Invalid choice. Enter 0, 1, 2, 3, or 4.\n")
  }
}

export async function promptAccountLabel(io?: PromptIO, current?: string) {
  const val = await ask(current ? `Account label [${current}]: ` : "Account label: ", io)
  if (val) return val
  if (current) return current
  return `account-${Date.now()}`
}

export async function promptLoginMenuFallback(accounts: Account[], activeIndex = -1, io?: PromptIO): Promise<Action> {
  const write = writer(io)
  while (true) {
    const items = buildAccountMenuItems(accounts, activeIndex)
    const lines = [
      "Manage ChatGPT accounts:",
      "  1. Add account (browser)",
      "  2. Add account (headless)",
    ]
    for (const [index, item] of items.entries()) {
      lines.push(`  ${index + 3}. ${item.label}${item.current ? " [current]" : ""} [${item.status}]`)
      lines.push(`     ${item.secondary}`)
      lines.push("     quota:")
      for (const line of item.fallbackQuotaLines) lines.push(`       ${line}`)
    }
    lines.push("  0. Done")
    write(lines.join("\n") + "\n")
    const value = await ask("Choice: ", io)
    if (value === "1") return { type: "add-browser" }
    if (value === "2") return { type: "add-headless" }
    if (value === "0" || value === "") return { type: "done" }
    const index = Number.parseInt(value, 10) - 3
    if (Number.isInteger(index) && index >= 0 && index < accounts.length) {
      const action = await promptAccountDetailsFallback(accounts, items, index, io)
      if (action.type === "back") continue
      return action
    }
    write("Invalid choice. Enter 0, 1, 2, or an account number.\n")
  }
}

export async function promptLoginMenu(accounts: Account[], activeIndex = -1): Promise<Action> {
  if (isTTY()) return promptLoginMenuTty(accounts, activeIndex)
  return promptLoginMenuFallback(accounts, activeIndex)
}
