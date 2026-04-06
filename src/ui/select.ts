import { ANSI, isTTY, parseKey } from "./ansi.js"

export type MenuItem<T = string> = {
  label: string
  value: T
  hint?: string
  disabled?: boolean
  separator?: boolean
  kind?: "heading"
  color?: "red" | "green" | "yellow" | "cyan"
}

export type SelectOptions = {
  message: string
  subtitle?: string
  help?: string
  clearScreen?: boolean
}

const ESCAPE_TIMEOUT_MS = 50
const ANSI_REGEX = new RegExp("\\x1b\\[[0-9;]*m", "g")
const ANSI_LEADING_REGEX = new RegExp("^\\x1b\\[[0-9;]*m")

function stripAnsi(input: string) {
  return input.replace(ANSI_REGEX, "")
}

function truncateAnsi(input: string, maxVisibleChars: number) {
  if (maxVisibleChars <= 0) return ""
  const visible = stripAnsi(input)
  if (visible.length <= maxVisibleChars) return input
  const suffix = maxVisibleChars >= 3 ? "..." : ".".repeat(maxVisibleChars)
  const keep = Math.max(0, maxVisibleChars - suffix.length)
  let out = ""
  let index = 0
  let kept = 0
  while (index < input.length && kept < keep) {
    if (input[index] === "\x1b") {
      const match = input.slice(index).match(ANSI_LEADING_REGEX)
      if (match) {
        out += match[0]
        index += match[0].length
        continue
      }
    }
    out += input[index]
    index += 1
    kept += 1
  }
  return out.includes("\x1b[") ? `${out}${ANSI.reset}${suffix}` : out + suffix
}

function colorCode(color: MenuItem["color"]) {
  if (color === "red") return ANSI.red
  if (color === "green") return ANSI.green
  if (color === "yellow") return ANSI.yellow
  if (color === "cyan") return ANSI.cyan
  return ""
}

export async function select<T>(items: MenuItem<T>[], options: SelectOptions): Promise<T | null> {
  if (!isTTY()) throw new Error("Interactive select requires a TTY terminal")
  if (items.length === 0) throw new Error("No menu items provided")
  const selectable = (item: MenuItem<T>) => !item.disabled && !item.separator && item.kind !== "heading"
  const enabled = items.filter(selectable)
  if (enabled.length === 0) throw new Error("All items disabled")
  if (enabled.length === 1) return enabled[0]!.value

  const { stdin, stdout } = process
  let cursor = items.findIndex(selectable)
  if (cursor === -1) cursor = 0
  let escapeTimeout: ReturnType<typeof setTimeout> | null = null
  let cleaned = false
  let renderedLines = 0

  const render = () => {
    const columns = stdout.columns ?? 80
    const rows = stdout.rows ?? 24
    const previousLines = renderedLines
    if (options.clearScreen) stdout.write(ANSI.clearScreen + ANSI.moveTo(1, 1))
    else if (previousLines > 0) stdout.write(ANSI.up(previousLines))

    let linesWritten = 0
    const writeLine = (line: string) => {
      stdout.write(`${ANSI.clearLine}${line}\n`)
      linesWritten += 1
    }

    const subtitleLines = options.subtitle ? 3 : 0
    const fixedLines = 1 + subtitleLines + 2
    const maxVisibleItems = Math.max(1, Math.min(items.length, rows - fixedLines - 1))
    let windowStart = 0
    let windowEnd = items.length
    if (items.length > maxVisibleItems) {
      windowStart = Math.max(0, Math.min(cursor - Math.floor(maxVisibleItems / 2), items.length - maxVisibleItems))
      windowEnd = windowStart + maxVisibleItems
    }
    const visibleItems = items.slice(windowStart, windowEnd)

    writeLine(`${ANSI.dim}┌  ${ANSI.reset}${truncateAnsi(options.message, Math.max(1, columns - 4))}`)
    if (options.subtitle) {
      writeLine(`${ANSI.dim}│${ANSI.reset}`)
      writeLine(`${ANSI.cyan}◆${ANSI.reset}  ${truncateAnsi(options.subtitle, Math.max(1, columns - 4))}`)
      writeLine("")
    }

    for (const [offset, item] of visibleItems.entries()) {
      const itemIndex = windowStart + offset
      if (item.separator) {
        writeLine(`${ANSI.dim}│${ANSI.reset}`)
        continue
      }
      if (item.kind === "heading") {
        writeLine(`${ANSI.cyan}│${ANSI.reset}  ${truncateAnsi(`${ANSI.dim}${ANSI.bold}${item.label}${ANSI.reset}`, Math.max(1, columns - 6))}`)
        continue
      }
      const selected = itemIndex === cursor
      let label = item.disabled
        ? `${ANSI.dim}${item.label} (unavailable)${ANSI.reset}`
        : colorCode(item.color)
          ? `${selected ? colorCode(item.color) : `${ANSI.dim}${colorCode(item.color)}`}${item.label}${ANSI.reset}`
          : selected
            ? item.label
            : `${ANSI.dim}${item.label}${ANSI.reset}`
      if (item.hint) label += ` ${ANSI.dim}${item.hint}${ANSI.reset}`
      label = truncateAnsi(label, Math.max(1, columns - 8))
      writeLine(`${ANSI.cyan}│${ANSI.reset}  ${selected ? `${ANSI.green}●${ANSI.reset}` : `${ANSI.dim}○${ANSI.reset}`} ${label}`)
    }

    const windowHint = items.length > visibleItems.length ? ` (${windowStart + 1}-${windowEnd}/${items.length})` : ""
    writeLine(`${ANSI.cyan}│${ANSI.reset}  ${ANSI.dim}${truncateAnsi(options.help ?? `Up/Down to select | Enter: confirm | Esc: back${windowHint}`, Math.max(1, columns - 6))}${ANSI.reset}`)
    writeLine(`${ANSI.cyan}└${ANSI.reset}`)

    if (!options.clearScreen && previousLines > linesWritten) {
      for (let i = 0; i < previousLines - linesWritten; i++) writeLine("")
    }
    renderedLines = linesWritten
  }

  return new Promise((resolve) => {
    const wasRaw = stdin.isRaw ?? false

    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      if (escapeTimeout) {
        clearTimeout(escapeTimeout)
        escapeTimeout = null
      }
      try {
        stdin.removeListener("data", onKey)
        stdin.setRawMode(wasRaw)
        stdin.pause()
        stdout.write(ANSI.show)
      } catch {}
      process.removeListener("SIGINT", onSignal)
      process.removeListener("SIGTERM", onSignal)
    }

    const finish = (value: T | null) => {
      cleanup()
      resolve(value)
    }

    const onSignal = () => finish(null)

    const nextSelectable = (from: number, direction: 1 | -1) => {
      let next = from
      do {
        next = (next + direction + items.length) % items.length
      } while (items[next]?.disabled || items[next]?.separator || items[next]?.kind === "heading")
      return next
    }

    const onKey = (data: Buffer) => {
      if (escapeTimeout) {
        clearTimeout(escapeTimeout)
        escapeTimeout = null
      }
      const action = parseKey(data)
      if (action === "up") {
        cursor = nextSelectable(cursor, -1)
        render()
        return
      }
      if (action === "down") {
        cursor = nextSelectable(cursor, 1)
        render()
        return
      }
      if (action === "enter") {
        finish(items[cursor]?.value ?? null)
        return
      }
      if (action === "escape") {
        finish(null)
        return
      }
      if (action === "escape-start") {
        escapeTimeout = setTimeout(() => finish(null), ESCAPE_TIMEOUT_MS)
      }
    }

    process.once("SIGINT", onSignal)
    process.once("SIGTERM", onSignal)
    try {
      stdin.setRawMode(true)
    } catch {
      cleanup()
      resolve(null)
      return
    }
    stdin.resume()
    stdout.write(ANSI.hide)
    render()
    stdin.on("data", onKey)
  })
}
