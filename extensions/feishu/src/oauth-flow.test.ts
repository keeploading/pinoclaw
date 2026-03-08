import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildFeishuOAuthUrl,
  cleanupExpiredOAuthStates,
  consumeOAuthPendingState,
  createOAuthPendingState,
  exchangeOAuthCode,
} from "./oauth-flow.js";

describe("buildFeishuOAuthUrl", () => {
  it("builds a correct Feishu auth URL", () => {
    const url = buildFeishuOAuthUrl({
      appId: "cli_test123",
      redirectUri: "https://example.com/feishu/oauth/callback",
      state: "abc-state",
    });
    expect(url).toContain("open.feishu.cn");
    expect(url).toContain("app_id=cli_test123");
    expect(url).toContain("state=abc-state");
    expect(url).toContain(encodeURIComponent("https://example.com/feishu/oauth/callback"));
  });

  it("uses Lark base URL for lark domain", () => {
    const url = buildFeishuOAuthUrl({
      appId: "cli_lark",
      redirectUri: "https://cb.example.com/cb",
      state: "s",
      domain: "lark",
    });
    expect(url).toContain("open.larksuite.com");
  });

  it("uses custom domain base URL", () => {
    const url = buildFeishuOAuthUrl({
      appId: "cli_priv",
      redirectUri: "https://cb.example.com/cb",
      state: "s",
      domain: "https://feishu.mycompany.com",
    });
    expect(url).toContain("feishu.mycompany.com");
  });
});

describe("OAuth pending state management", () => {
  it("creates and consumes a state entry", () => {
    const state = createOAuthPendingState({
      accountId: "default",
      chatId: "oc_chat1",
      senderOpenId: "ou_user1",
    });
    expect(typeof state).toBe("string");
    const entry = consumeOAuthPendingState(state);
    expect(entry?.accountId).toBe("default");
    expect(entry?.chatId).toBe("oc_chat1");
    expect(entry?.senderOpenId).toBe("ou_user1");
  });

  it("returns undefined for an unknown state", () => {
    expect(consumeOAuthPendingState("nonexistent")).toBeUndefined();
  });

  it("consumes a state only once (prevents replay)", () => {
    const state = createOAuthPendingState({
      accountId: "a",
      chatId: "c",
      senderOpenId: "ou_x",
    });
    consumeOAuthPendingState(state);
    expect(consumeOAuthPendingState(state)).toBeUndefined();
  });

  it("cleanupExpiredOAuthStates removes expired entries", () => {
    vi.useFakeTimers();
    const state = createOAuthPendingState({
      accountId: "a",
      chatId: "c",
      senderOpenId: "ou_x",
    });
    // Advance 11 minutes past TTL.
    vi.advanceTimersByTime(11 * 60 * 1000);
    cleanupExpiredOAuthStates();
    expect(consumeOAuthPendingState(state)).toBeUndefined();
    vi.useRealTimers();
  });
});

describe("exchangeOAuthCode", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns user info on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        // First call: app_access_token
        .mockResolvedValueOnce({
          json: async () => ({
            code: 0,
            msg: "ok",
            app_access_token: "app_tok_test",
          }),
        })
        // Second call: oidc/access_token
        .mockResolvedValueOnce({
          json: async () => ({
            code: 0,
            msg: "ok",
            data: { access_token: "user_tok", refresh_token: "ref_tok", expires_in: 7200 },
          }),
        })
        // Third call: user_info
        .mockResolvedValueOnce({
          json: async () => ({
            code: 0,
            msg: "ok",
            data: {
              open_id: "ou_abc",
              name: "Alice",
              tenant_key: "nio",
            },
          }),
        }),
    );

    const result = await exchangeOAuthCode({
      code: "auth_code",
      appId: "cli_test",
      appSecret: "secret",
    });

    expect(result.openId).toBe("ou_abc");
    expect(result.name).toBe("Alice");
    expect(result.tenantKey).toBe("nio");
  });

  it("throws when app access token fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        json: async () => ({ code: 10012, msg: "app_id not found" }),
      }),
    );

    await expect(
      exchangeOAuthCode({ code: "c", appId: "bad_id", appSecret: "bad_secret" }),
    ).rejects.toThrow("app_id not found");
  });

  it("throws when code exchange fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          json: async () => ({ code: 0, app_access_token: "tok" }),
        })
        .mockResolvedValueOnce({
          json: async () => ({ code: 20021, msg: "invalid code" }),
        }),
    );

    await expect(
      exchangeOAuthCode({ code: "bad_code", appId: "cli_test", appSecret: "secret" }),
    ).rejects.toThrow("invalid code");
  });
});
