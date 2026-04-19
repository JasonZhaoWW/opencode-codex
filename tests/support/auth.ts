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
