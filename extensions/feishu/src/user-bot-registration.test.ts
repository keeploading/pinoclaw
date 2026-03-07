import type { OpenClawConfig } from "openclaw/plugin-sdk/feishu";
import type { PluginRuntime } from "openclaw/plugin-sdk/feishu";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { validateFeishuBotCredentials, registerUserBot } from "./user-bot-registration.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockRuntime(writtenConfigs: OpenClawConfig[] = []): PluginRuntime {
  return {
    config: {
      loadConfig: vi.fn(),
      writeConfigFile: vi.fn(async (cfg: OpenClawConfig) => {
        writtenConfigs.push(cfg);
      }),
    },
    system: {} as PluginRuntime["system"],
    media: {} as PluginRuntime["media"],
    tts: {} as PluginRuntime["tts"],
    stt: {} as PluginRuntime["stt"],
    tools: {} as PluginRuntime["tools"],
    events: {} as PluginRuntime["events"],
    logging: {} as PluginRuntime["logging"],
    state: {} as PluginRuntime["state"],
    version: "test",
    subagent: {} as PluginRuntime["subagent"],
    channel: {} as PluginRuntime["channel"],
  } as unknown as PluginRuntime;
}

function mockFetch(responses: Array<object>): void {
  let call = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const body = responses[call++] ?? { code: 0, tenant_access_token: "tok" };
      return { json: async () => body } as Response;
    }),
  );
}

// ---------------------------------------------------------------------------
// validateFeishuBotCredentials
// ---------------------------------------------------------------------------

describe("validateFeishuBotCredentials", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves with token and bot info on success", async () => {
    mockFetch([
      { code: 0, tenant_access_token: "t-abc123", expire: 7200 },
      { code: 0, bot: { app_name: "My Bot", open_id: "ou_xxx" } },
    ]);

    const result = await validateFeishuBotCredentials({
      appId: "cli_test",
      appSecret: "secret",
    });

    expect(result.tenantAccessToken).toBe("t-abc123");
    expect(result.appName).toBe("My Bot");
    expect(result.botOpenId).toBe("ou_xxx");
  });

  it("throws when code is non-zero (bad credentials)", async () => {
    mockFetch([{ code: 10003, msg: "app_not_found" }]);

    await expect(
      validateFeishuBotCredentials({ appId: "cli_bad", appSecret: "bad" }),
    ).rejects.toThrow(/Feishu credentials invalid.*10003/);
  });

  it("throws when tenant_access_token is missing from success response", async () => {
    mockFetch([{ code: 0, msg: "ok" }]);

    await expect(
      validateFeishuBotCredentials({ appId: "cli_test", appSecret: "secret" }),
    ).rejects.toThrow(/Feishu credentials invalid/);
  });

  it("succeeds even when bot info request fails (best-effort)", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++;
        if (call === 1) {
          return { json: async () => ({ code: 0, tenant_access_token: "t-ok" }) } as Response;
        }
        throw new Error("network error");
      }),
    );

    const result = await validateFeishuBotCredentials({ appId: "cli_test", appSecret: "secret" });
    expect(result.tenantAccessToken).toBe("t-ok");
    expect(result.appName).toBeUndefined();
  });

  it("uses Lark API base URL for lark domain", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return { json: async () => ({ code: 0, tenant_access_token: "t-lark" }) } as Response;
      }),
    );

    await validateFeishuBotCredentials({ appId: "cli_test", appSecret: "secret", domain: "lark" });
    expect(calls[0]).toContain("larksuite.com");
  });
});

// ---------------------------------------------------------------------------
// registerUserBot
// ---------------------------------------------------------------------------

describe("registerUserBot", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.mock("node:fs/promises", () => ({
      default: { mkdir: vi.fn().mockResolvedValue(undefined) },
    }));
  });

  const baseConfig: OpenClawConfig = {
    channels: { feishu: { appId: "cli_admin", appSecret: "admin_secret" } },
  };

  it("adds a new account under channels.feishu.accounts", async () => {
    mockFetch([
      { code: 0, tenant_access_token: "tok" },
      { code: 0, bot: { app_name: "User Bot" } },
    ]);

    const written: OpenClawConfig[] = [];
    const runtime = makeMockRuntime(written);

    const result = await registerUserBot({
      cfg: baseConfig,
      runtime,
      appId: "cli_user",
      appSecret: "user_secret",
      autoCreateAgent: false, // skip fs operations in this test
    });

    expect(result.accountId).toBe("user-cli-user");
    expect(result.appName).toBe("User Bot");
    expect(written).toHaveLength(1);

    const savedCfg = written[0];
    const accounts = (savedCfg?.channels?.feishu as Record<string, unknown>)?.accounts as Record<
      string,
      unknown
    >;
    expect(accounts?.["user-cli-user"]).toMatchObject({
      appId: "cli_user",
      appSecret: "user_secret",
      name: "User Bot",
    });
  });

  it("derives stable accountId from appId, normalising special chars", async () => {
    mockFetch([{ code: 0, tenant_access_token: "tok" }, { code: 0 }]);

    const written: OpenClawConfig[] = [];
    const runtime = makeMockRuntime(written);

    const result = await registerUserBot({
      cfg: baseConfig,
      runtime,
      appId: "CLI_A1b2!@#",
      appSecret: "s",
      autoCreateAgent: false,
    });

    // special chars stripped/replaced with hyphens, lowercased
    expect(result.accountId).toMatch(/^user-cli-a1b2/);
    expect(result.accountId).not.toMatch(/[!@#]/);
  });

  it("throws when credentials are invalid", async () => {
    mockFetch([{ code: 10003, msg: "invalid app" }]);

    const runtime = makeMockRuntime();

    await expect(
      registerUserBot({
        cfg: baseConfig,
        runtime,
        appId: "cli_bad",
        appSecret: "bad",
      }),
    ).rejects.toThrow(/Feishu credentials invalid/);

    // config must NOT be written on validation failure
    expect(runtime.config.writeConfigFile).not.toHaveBeenCalled();
  });

  it("preserves existing accounts when adding a new one", async () => {
    mockFetch([{ code: 0, tenant_access_token: "tok" }, { code: 0 }]);

    const cfgWithExisting: OpenClawConfig = {
      channels: {
        feishu: {
          appId: "cli_admin",
          appSecret: "admin_secret",
          accounts: {
            "user-existing": { appId: "cli_exist", appSecret: "exist_sec" },
          },
        },
      },
    };

    const written: OpenClawConfig[] = [];
    const runtime = makeMockRuntime(written);

    await registerUserBot({
      cfg: cfgWithExisting,
      runtime,
      appId: "cli_new",
      appSecret: "new_sec",
      autoCreateAgent: false,
    });

    const accounts = (written[0]?.channels?.feishu as Record<string, unknown>)?.accounts as Record<
      string,
      unknown
    >;
    // Both old and new account must be present
    expect(accounts?.["user-existing"]).toBeDefined();
    expect(accounts?.["user-cli-new"]).toBeDefined();
  });
});
