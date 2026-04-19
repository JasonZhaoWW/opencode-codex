import { expect, test } from "bun:test"

import { parseLimitFailure, parseLimitHeaders, parseUsageLimits } from "../../src/limits.js"

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
