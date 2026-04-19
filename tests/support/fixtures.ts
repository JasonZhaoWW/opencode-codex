import type { PluginInput } from "@opencode-ai/plugin"
import { DEFAULT_LIMIT_ID } from "../../src/constants.js"
import type { Account, Store } from "../../src/storage.js"

export function client() {
  return {
    auth: {
      set: async () => undefined,
    },
  } as unknown as PluginInput["client"]
}

export function account(label: string, limits: Account["limits"], activeLimitId = DEFAULT_LIMIT_ID, extra: Partial<Account> = {}): Account {
  return {
    label,
    refreshToken: `${label}-refresh`,
    accessToken: `${label}-access`,
    tokenExpires: Date.now() + 3_600_000,
    addedAt: Date.now(),
    lastUsed: 0,
    enabled: true,
    activeLimitId,
    limits,
    ...extra,
  }
}

export function store(accounts: Account[], activeIndex = 0): Store {
  return {
    version: 1,
    activeIndex,
    accounts,
  }
}
