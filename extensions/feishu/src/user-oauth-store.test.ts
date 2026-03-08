import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteUserOAuthToken,
  isUserOAuthTokenValid,
  loadUserOAuthToken,
  resolveUserAuthDir,
  saveUserOAuthToken,
} from "./user-oauth-store.js";
import type { FeishuUserOAuthToken } from "./user-oauth-store.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-oauth-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeToken(overrides: Partial<FeishuUserOAuthToken> = {}): FeishuUserOAuthToken {
  return {
    openId: "ou_abc123",
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    name: "Test User",
    tenantKey: "nio",
    authenticatedAt: Date.now(),
    ...overrides,
  };
}

describe("resolveUserAuthDir", () => {
  it("returns credentialsDir/feishu-user-auth", () => {
    expect(resolveUserAuthDir("/home/user/.openclaw/credentials")).toBe(
      "/home/user/.openclaw/credentials/feishu-user-auth",
    );
  });
});

describe("saveUserOAuthToken / loadUserOAuthToken", () => {
  it("saves and loads a token round-trip", async () => {
    const token = makeToken();
    await saveUserOAuthToken(tmpDir, token);
    const loaded = await loadUserOAuthToken(tmpDir, token.openId);
    expect(loaded).toEqual(token);
  });

  it("returns undefined for a missing token", async () => {
    const result = await loadUserOAuthToken(tmpDir, "ou_nonexistent");
    expect(result).toBeUndefined();
  });

  it("creates the directory if it does not exist", async () => {
    const nestedDir = path.join(tmpDir, "sub", "creds");
    const token = makeToken({ openId: "ou_new" });
    await saveUserOAuthToken(nestedDir, token);
    const loaded = await loadUserOAuthToken(nestedDir, token.openId);
    expect(loaded?.openId).toBe("ou_new");
  });

  it("overwrites an existing token", async () => {
    const token = makeToken({ name: "Old Name" });
    await saveUserOAuthToken(tmpDir, token);
    const updated = { ...token, name: "New Name" };
    await saveUserOAuthToken(tmpDir, updated);
    const loaded = await loadUserOAuthToken(tmpDir, token.openId);
    expect(loaded?.name).toBe("New Name");
  });
});

describe("deleteUserOAuthToken", () => {
  it("removes a stored token", async () => {
    const token = makeToken();
    await saveUserOAuthToken(tmpDir, token);
    await deleteUserOAuthToken(tmpDir, token.openId);
    expect(await loadUserOAuthToken(tmpDir, token.openId)).toBeUndefined();
  });

  it("does not throw if the token does not exist", async () => {
    await expect(deleteUserOAuthToken(tmpDir, "ou_missing")).resolves.not.toThrow();
  });
});

describe("isUserOAuthTokenValid", () => {
  it("returns true for a future expiresAt", () => {
    expect(isUserOAuthTokenValid(makeToken({ expiresAt: Date.now() + 1000 }))).toBe(true);
  });

  it("returns false for an expired token", () => {
    expect(isUserOAuthTokenValid(makeToken({ expiresAt: Date.now() - 1 }))).toBe(false);
  });
});
