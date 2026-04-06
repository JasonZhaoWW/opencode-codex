export const ANSI = {
  hide: "\x1b[?25l",
  show: "\x1b[?25h",
  up: (n = 1) => `\x1b[${n}A`,
  clearLine: "\x1b[2K",
  clearScreen: "\x1b[2J",
  moveTo: (row: number, col: number) => `\x1b[${row};${col}H`,
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
} as const

export type KeyAction = "up" | "down" | "enter" | "escape" | "escape-start" | null

export function parseKey(data: Buffer): KeyAction {
  const value = data.toString()
  if (value === "\x1b[A" || value === "\x1bOA") return "up"
  if (value === "\x1b[B" || value === "\x1bOB") return "down"
  if (value === "\r" || value === "\n") return "enter"
  if (value === "\x03") return "escape"
  if (value === "\x1b") return "escape-start"
  return null
}

export function isTTY() {
  return Boolean(process.stdin.isTTY)
}
