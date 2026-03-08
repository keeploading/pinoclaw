import type { FeishuDomain } from "./types.js";

const FEISHU_OPEN_API = "https://open.feishu.cn/open-apis";
const LARK_OPEN_API = "https://open.larksuite.com/open-apis";
const REQUEST_TIMEOUT_MS = 10_000;
/** Pending OAuth states expire after 10 minutes. */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function resolveOpenApiBase(domain?: FeishuDomain): string {
  if (domain === "lark") return LARK_OPEN_API;
  if (domain && domain !== "feishu" && domain.startsWith("https://")) {
    return `${domain.replace(/\/+$/, "")}/open-apis`;
  }
  return FEISHU_OPEN_API;
}

// ── Pending OAuth states ─────────────────────────────────────────────────────

export type OAuthPendingState = {
  accountId: string;
  chatId: string;
  senderOpenId: string;
  createdAt: number;
};

// In-memory map: state token → pending entry.
// Each entry is consumed once on callback (prevents replay).
const pendingOAuthStates = new Map<string, OAuthPendingState>();

export function createOAuthPendingState(params: Omit<OAuthPendingState, "createdAt">): string {
  const state = crypto.randomUUID();
  pendingOAuthStates.set(state, { ...params, createdAt: Date.now() });
  return state;
}

/** Consumes (removes) and returns the pending state, or undefined if missing/expired. */
export function consumeOAuthPendingState(state: string): OAuthPendingState | undefined {
  const entry = pendingOAuthStates.get(state);
  if (!entry) return undefined;
  pendingOAuthStates.delete(state);
  if (Date.now() - entry.createdAt > OAUTH_STATE_TTL_MS) return undefined;
  return entry;
}

/** Remove stale pending states (call periodically to avoid memory leak). */
export function cleanupExpiredOAuthStates(): void {
  const now = Date.now();
  for (const [key, entry] of pendingOAuthStates) {
    if (now - entry.createdAt > OAUTH_STATE_TTL_MS) {
      pendingOAuthStates.delete(key);
    }
  }
}

// ── OAuth URL building ────────────────────────────────────────────────────────

export function buildFeishuOAuthUrl(params: {
  appId: string;
  redirectUri: string;
  state: string;
  domain?: FeishuDomain;
}): string {
  const { appId, redirectUri, state, domain } = params;
  const base = resolveOpenApiBase(domain);
  const url = new URL(`${base}/authen/v1/authorize`);
  url.searchParams.set("app_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

// ── Feishu API calls ──────────────────────────────────────────────────────────

type AppAccessTokenResponse = {
  code: number;
  msg: string;
  app_access_token?: string;
};

async function getAppAccessToken(params: {
  appId: string;
  appSecret: string;
  domain?: FeishuDomain;
}): Promise<string> {
  const { appId, appSecret, domain } = params;
  const base = resolveOpenApiBase(domain);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/auth/v3/app_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: controller.signal,
    });
    const data = (await res.json()) as AppAccessTokenResponse;
    if (data.code !== 0 || !data.app_access_token) {
      throw new Error(
        `Failed to get app access token: ${data.msg ?? "unknown"} (code ${data.code})`,
      );
    }
    return data.app_access_token;
  } finally {
    clearTimeout(timeout);
  }
}

type OAuthTokenResponse = {
  code: number;
  msg: string;
  data?: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
};

type OAuthUserInfoResponse = {
  code: number;
  msg: string;
  data?: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
    name?: string;
    en_name?: string;
    email?: string;
    mobile?: string;
    avatar_url?: string;
    tenant_key?: string;
  };
};

export type FeishuOAuthUserInfo = {
  openId: string;
  userId?: string;
  unionId?: string;
  name?: string;
  enName?: string;
  email?: string;
  mobile?: string;
  avatarUrl?: string;
  tenantKey?: string;
};

/**
 * Exchange a Feishu OAuth authorization code for user identity.
 * Returns user info on success; throws on failure.
 */
export async function exchangeOAuthCode(params: {
  code: string;
  appId: string;
  appSecret: string;
  domain?: FeishuDomain;
}): Promise<FeishuOAuthUserInfo> {
  const { code, appId, appSecret, domain } = params;
  const base = resolveOpenApiBase(domain);

  const appToken = await getAppAccessToken({ appId, appSecret, domain });

  // Exchange authorization code for user access token.
  const tokenController = new AbortController();
  const tokenTimeout = setTimeout(() => tokenController.abort(), REQUEST_TIMEOUT_MS);
  let tokenData: OAuthTokenResponse;
  try {
    const res = await fetch(`${base}/authen/v1/oidc/access_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${appToken}`,
      },
      body: JSON.stringify({ grant_type: "authorization_code", code }),
      signal: tokenController.signal,
    });
    tokenData = (await res.json()) as OAuthTokenResponse;
  } finally {
    clearTimeout(tokenTimeout);
  }

  if (tokenData.code !== 0 || !tokenData.data?.access_token) {
    throw new Error(
      `OAuth code exchange failed: ${tokenData.msg ?? "unknown"} (code ${tokenData.code})`,
    );
  }

  const userAccessToken = tokenData.data.access_token;

  // Fetch user identity.
  const infoController = new AbortController();
  const infoTimeout = setTimeout(() => infoController.abort(), REQUEST_TIMEOUT_MS);
  let infoData: OAuthUserInfoResponse;
  try {
    const res = await fetch(`${base}/authen/v1/user_info`, {
      headers: { Authorization: `Bearer ${userAccessToken}` },
      signal: infoController.signal,
    });
    infoData = (await res.json()) as OAuthUserInfoResponse;
  } finally {
    clearTimeout(infoTimeout);
  }

  if (infoData.code !== 0 || !infoData.data?.open_id) {
    throw new Error(`Failed to fetch user info: ${infoData.msg ?? "unknown"}`);
  }

  const info = infoData.data;
  return {
    openId: info.open_id!,
    userId: info.user_id,
    unionId: info.union_id,
    name: info.name,
    enName: info.en_name,
    email: info.email,
    mobile: info.mobile,
    avatarUrl: info.avatar_url,
    tenantKey: info.tenant_key,
  };
}
