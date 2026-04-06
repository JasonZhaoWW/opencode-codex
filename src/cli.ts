import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
import { DEFAULT_LIMIT_ID } from "./constants.js"
import { limitBlocked, limitReset } from "./limits.js"
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

function describe(acc: Account, id: string) {
  const snap = acc.limits[id]
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

function describeCompact(acc: Account, id: string) {
  const snap = acc.limits[id]
  if (!snap) return []
  return [snap.primary, snap.secondary].flatMap((win) => {
    if (!win) return []
    return [`${shortLabel(win.windowMinutes)} ${Math.round(remain(win.usedPercent))}%`]
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
    const active = acc.limits[acc.activeLimitId] || acc.limits[DEFAULT_LIMIT_ID]
    const status =
      acc.enabled === false
        ? "disabled"
        : (acc.rateLimitResetTime && acc.rateLimitResetTime > Date.now()) || limitBlocked(active)
          ? "rate-limited"
          : "active"
    const base = describe(acc, DEFAULT_LIMIT_ID)
    const compactBase = describeCompact(acc, DEFAULT_LIMIT_ID)
    const extra = Object.entries(acc.limits).flatMap(([id, snap]) => {
      if (id === DEFAULT_LIMIT_ID) return []
      const hit = describe(acc, id)
      if (hit.length === 0) return []
      return [`${snap.limitName || id} ${hit.join(" / ")}`]
    })
    const compactExtra = Object.entries(acc.limits).flatMap(([id, snap]) => {
      if (id === DEFAULT_LIMIT_ID) return []
      const hit = describeCompact(acc, id)
      if (hit.length === 0) return []
      return [`${snap.limitName || id} ${hit.join(" / ")}`]
    })
    const quotaSummary = [...base, ...extra].join(" | ") || "quota not loaded yet"
    const secondary = [
      acc.email && acc.email !== acc.label ? `label ${acc.label}` : undefined,
      acc.lastUsed > 0 ? `used ${relativeTime(acc.lastUsed)}` : "never used",
    ]
      .filter((value): value is string => Boolean(value))
      .join(" | ")
    const nextReset = (() => {
      if (acc.rateLimitResetTime && acc.rateLimitResetTime > Date.now()) return acc.rateLimitResetTime
      return limitReset(active, Date.now())
    })()
    const menuHint = [
      secondary,
      [...compactBase, ...compactExtra].join(" | ") || "quota unknown",
      status === "rate-limited" && nextReset ? `next ${new Date(nextReset).toLocaleTimeString()}` : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" | ")
    return {
      label: acc.email || acc.label,
      status,
      secondary,
      menuHint,
      quotaSummary,
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
        { label: `Quota: ${item.quotaSummary}`, value: { type: "back" }, kind: "heading" },
        { label: "", value: { type: "back" }, separator: true },
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
        hint: item.menuHint,
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
        `  quota: ${item.quotaSummary}`,
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
      lines.push(`     quota: ${item.quotaSummary}`)
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
