import { expect, test } from "bun:test"

import { extractAccountId, extractPlanType, extractUserId, isPermanentTokenRefreshError, parseChatGptAccessToken, refreshAccessToken, TokenRefreshError } from "../../src/oauth.js"
import { chatgptAccessToken, jwt, oauthToken } from "../support/auth.js"
import { installFetch } from "../support/fetch.js"

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

test("parseChatGptAccessToken extracts expiration and identity metadata", () => {
  const exp = Math.trunc(Date.now() / 1000) + 1800
  const access = chatgptAccessToken({ userId: "user-123", accountId: "acct-123", planType: "plus", exp })

  expect(parseChatGptAccessToken(access)).toEqual({
    accessToken: access,
    tokenExpires: exp * 1000,
    email: "user@example.com",
    planType: "plus",
    userId: "user-123",
    accountId: "acct-123",
  })
})

test("parseChatGptAccessToken extracts email from profile namespace", () => {
  const exp = Math.trunc(Date.now() / 1000) + 1800
  const access = jwt({
    exp,
    "https://api.openai.com/auth": { chatgpt_user_id: "user-123", chatgpt_account_id: "acct-123" },
    "https://api.openai.com/profile": { email: "profile@example.com" },
  })

  expect(parseChatGptAccessToken(access).email).toBe("profile@example.com")
})

test("parseChatGptAccessToken rejects malformed tokens", () => {
  expect(() => parseChatGptAccessToken("not-a-jwt")).toThrow("valid ChatGPT OAuth access token")
})

test("parseChatGptAccessToken rejects tokens without expiration", () => {
  expect(() => parseChatGptAccessToken(jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" } }))).toThrow("expiration claim")
})

test("parseChatGptAccessToken rejects tokens without account identity", () => {
  expect(() => parseChatGptAccessToken(chatgptAccessToken({ userId: "user-123" }))).toThrow("user ID and account or workspace identifier")
})

test("parseChatGptAccessToken rejects tokens without user identity", () => {
  expect(() => parseChatGptAccessToken(chatgptAccessToken({ accountId: "acct-123" }))).toThrow("user ID and account or workspace identifier")
})

const permanentRefreshFailures = [
  {
    name: "expired refresh token",
    status: 401,
    body: { error: { code: "refresh_token_expired" } },
    message: "refresh token has expired",
  },
  {
    name: "reused refresh token",
    status: 401,
    body: { error: { code: "refresh_token_reused" } },
    message: "refresh token was already used",
  },
  {
    name: "revoked refresh token",
    status: 401,
    body: { error: { code: "refresh_token_invalidated" } },
    message: "refresh token was revoked",
  },
  {
    name: "invalid refresh token",
    status: 400,
    body: { error: "invalid_grant", error_description: "bad refresh token" },
    message: "refresh token is invalid",
  },
]

for (const failure of permanentRefreshFailures) {
  test(`refreshAccessToken surfaces permanent failure for ${failure.name}`, async () => {
    const restore = installFetch((async () => {
      return new Response(JSON.stringify(failure.body), {
        status: failure.status,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch)
    try {
      let error: unknown
      try {
        await refreshAccessToken("bad-refresh")
      } catch (err) {
        error = err
      }

      expect(error).toBeInstanceOf(TokenRefreshError)
      expect(isPermanentTokenRefreshError(error)).toBe(true)
      expect((error as Error).message).toContain(failure.message)
    } finally {
      restore()
    }
  })
}
