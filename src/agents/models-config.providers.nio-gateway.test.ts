import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveApiKeyForProvider } from "./model-auth.js";
import { buildNioGatewayProvider, resolveImplicitProviders } from "./models-config.providers.js";

describe("NIO Gateway provider", () => {
  it("should include nio-gateway when NIO_GATEWAY_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await withEnvAsync({ NIO_GATEWAY_API_KEY: "test-key" }, async () => {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.["nio-gateway"]).toBeDefined();
      expect(providers?.["nio-gateway"]?.models?.length).toBeGreaterThan(0);
    });
  });

  it("should not include nio-gateway when NIO_GATEWAY_API_KEY is absent", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await withEnvAsync({ NIO_GATEWAY_API_KEY: undefined }, async () => {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.["nio-gateway"]).toBeUndefined();
    });
  });

  it("resolves the nio-gateway api key value from env", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await withEnvAsync({ NIO_GATEWAY_API_KEY: "nio-test-api-key" }, async () => {
      const auth = await resolveApiKeyForProvider({
        provider: "nio-gateway",
        agentDir,
      });
      expect(auth.apiKey).toBe("nio-test-api-key");
      expect(auth.mode).toBe("api-key");
      expect(auth.source).toContain("NIO_GATEWAY_API_KEY");
    });
  });

  it("should build nio-gateway provider with correct configuration", () => {
    const provider = buildNioGatewayProvider();
    expect(provider.baseUrl).toBe("https://modelgateway.nioint.com/publicService");
    expect(provider.api).toBe("openai-completions");
    expect(provider.models).toBeDefined();
    expect(provider.models.length).toBeGreaterThan(0);
  });

  it("should include DeepSeek-V3.2 as the default model", () => {
    const provider = buildNioGatewayProvider();
    const modelIds = provider.models.map((m) => m.id);
    expect(modelIds).toContain("DeepSeek-V3.2");
  });

  it("should have expected context window for DeepSeek-V3.2", () => {
    const provider = buildNioGatewayProvider();
    const model = provider.models.find((m) => m.id === "DeepSeek-V3.2");
    expect(model?.contextWindow).toBe(128000);
  });
});
