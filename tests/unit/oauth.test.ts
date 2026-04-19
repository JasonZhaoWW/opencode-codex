import { expect, test } from "bun:test"

import { extractAccountId, extractPlanType, extractUserId } from "../../src/oauth.js"
import { oauthToken } from "../support/auth.js"

test("oauth identity extraction separates user and account ids", () => {
  const token = oauthToken({ userId: "user-123", accountId: "acct-shared", organizationId: "org-blue", planType: "business" })

  expect(extractPlanType(token)).toBe("business")
  expect(extractUserId(token)).toBe("user-123")
  expect(extractAccountId(token)).toBe("acct-shared")
})

test("oauth identity extraction falls back to organization for account id", () => {
  const token = oauthToken({ userId: "user-123", organizationId: "org-shared", refreshToken: "refresh-only-org" })

  expect(extractUserId(token)).toBe("user-123")
  expect(extractAccountId(token)).toBe("org-shared")
})
