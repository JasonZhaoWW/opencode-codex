export function jwt(payload: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.${Buffer.from("sig").toString("base64url")}`
}

export function oauthToken({
  userId,
  accountId,
  organizationId,
  planType,
  refreshToken = `${userId || "user"}-${accountId || organizationId || "account"}-refresh`,
}: {
  userId?: string
  accountId?: string
  organizationId?: string
  planType?: string
  refreshToken?: string
} = {}) {
  return {
    access_token: jwt({
      email: "user@example.com",
      ...(organizationId ? { organizations: [{ id: organizationId }] } : {}),
      "https://api.openai.com/auth": {
        ...(planType ? { chatgpt_plan_type: planType } : {}),
        ...(userId ? { chatgpt_user_id: userId, user_id: userId } : {}),
        ...(accountId ? { chatgpt_account_id: accountId } : {}),
        ...(organizationId ? { organization_id: organizationId } : {}),
      },
    }),
    refresh_token: refreshToken,
    expires_in: 3600,
  }
}

export function chatgptAccessToken({
  userId,
  accountId,
  organizationId,
  workspaceId,
  planType,
  exp = Math.trunc(Date.now() / 1000) + 3600,
  email = "user@example.com",
  extra = {},
}: {
  userId?: string
  accountId?: string
  organizationId?: string
  workspaceId?: string
  planType?: string
  exp?: number
  email?: string
  extra?: Record<string, unknown>
} = {}) {
  return jwt({
    email,
    exp,
    ...(organizationId ? { organizations: [{ id: organizationId }] } : {}),
    ...extra,
    "https://api.openai.com/auth": {
      ...(planType ? { chatgpt_plan_type: planType } : {}),
      ...(userId ? { chatgpt_user_id: userId, user_id: userId } : {}),
      ...(accountId ? { chatgpt_account_id: accountId } : {}),
      ...(organizationId ? { organization_id: organizationId } : {}),
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
    },
  })
}
