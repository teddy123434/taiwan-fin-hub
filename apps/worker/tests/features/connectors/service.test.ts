import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import { getConnectorSettings } from "../../../src/db";
import { decryptJson, encryptJson } from "../../../src/platform/crypto";
import type { Env } from "../../../src/platform/env";
import {
  getConnectorSettingsView,
  updateConnectorSettings,
} from "../../../src/features/connectors/service";

const key = "synthetic-test-encryption-key";
const credentials = {
  userId: "A123456789",
  account: "synthetic-user",
  password: "synthetic-password",
};

describe("連線設定的憑證安全（隔離 D1）", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  beforeAll(async () => {
    harness = await createTestD1();
  }, 60_000);
  afterAll(async () => {
    await harness?.mf.dispose();
  });

  // Zod 3 接受所有 8-4-4-4-12 十六進位裝置識別碼；升級不得拒絕既有設定。
  it("更新新光設定時保留舊版可接受的裝置識別碼與加密憑證", async () => {
    const env = {
      DB: harness.binding,
      CONFIG_ENCRYPTION_KEY: key,
      GENERATED_CONFIG_ENCRYPTION_KEY: "synthetic-unused-generated-key",
    } as Env;
    const config = {
      nationalId: credentials.userId,
      alias: credentials.account,
      password: credentials.password,
      deviceId: "00000000-0000-0000-0000-000000000001",
    };
    await updateConnectorSettings(env, "skbank", config);
    await updateConnectorSettings(env, "skbank", {});

    const stored = await getConnectorSettings(env.DB, "skbank");
    expect(await decryptJson(stored!.encrypted_config, key)).toEqual(config);
    expect(stored?.encrypted_config).not.toContain(config.password);
    expect(
      JSON.stringify(await getConnectorSettingsView(env, "skbank")),
    ).not.toContain(config.deviceId);
  });

  it("auto 使用已保存的隨機金鑰，重新部署後仍可讀取既有設定", async () => {
    const generatedKey = "a".repeat(64);
    const env = {
      DB: harness.binding,
      CONFIG_ENCRYPTION_KEY: "auto",
      GENERATED_CONFIG_ENCRYPTION_KEY: generatedKey,
    } as Env;
    await updateConnectorSettings(env, "taishin", credentials);
    const stored = await getConnectorSettings(env.DB, "taishin");
    expect(await decryptJson(stored!.encrypted_config, generatedKey)).toEqual(
      credentials,
    );
    await expect(
      decryptJson(stored!.encrypted_config, "auto"),
    ).rejects.toThrow();

    await updateConnectorSettings({ ...env }, "taishin", {});
    expect(await getConnectorSettingsView({ ...env }, "taishin")).toMatchObject(
      {
        configured: true,
        credentialsComplete: true,
      },
    );
    expect(
      JSON.stringify(await getConnectorSettingsView(env, "taishin")),
    ).not.toContain(generatedKey);
  });

  it("auto 缺少真正金鑰時拒絕寫入，也不把 auto 本身當成金鑰", async () => {
    const env = { DB: harness.binding, CONFIG_ENCRYPTION_KEY: "auto" } as Env;
    for (const generatedKey of [undefined, "auto"]) {
      await expect(
        updateConnectorSettings(
          { ...env, GENERATED_CONFIG_ENCRYPTION_KEY: generatedKey },
          "esun",
          credentials,
        ),
      ).rejects.toThrow(/requires GENERATED_CONFIG_ENCRYPTION_KEY/);
    }
    expect(await getConnectorSettings(env.DB, "esun")).toBeNull();
  });

  it("主金鑰設定遺失時不自動切換到 generated 金鑰", async () => {
    const env = {
      DB: harness.binding,
      GENERATED_CONFIG_ENCRYPTION_KEY: "synthetic-generated-key",
    } as Env;
    await expect(
      updateConnectorSettings(env, "esun", credentials),
    ).rejects.toThrow(/CONFIG_ENCRYPTION_KEY is required/);
    expect(await getConnectorSettings(env.DB, "esun")).toBeNull();
  });

  it("加密儲存且公開 view 不洩漏秘密，變更帳密後移除舊 session 與 cursor", async () => {
    const env = { DB: harness.binding, CONFIG_ENCRYPTION_KEY: key } as Env;
    await updateConnectorSettings(env, "sinopac", credentials);
    const encrypted = await encryptJson(
      {
        ...credentials,
        protocol: "sinopac-mobile-app-json-v1",
        sessionCookies: "synthetic-private-cookie",
        browserSessionId: "synthetic-private-challenge",
        captcha: "123456",
      },
      key,
    );
    await env.DB.prepare(
      "UPDATE connector_settings SET encrypted_config = ?, sync_cursor = 'old-cursor' WHERE connector_id = 'sinopac'",
    )
      .bind(encrypted)
      .run();
    const stored = await getConnectorSettings(env.DB, "sinopac");
    expect(stored?.encrypted_config).not.toContain(credentials.password);
    expect(stored?.encrypted_config).not.toContain("synthetic-private");
    await expect(decryptJson(encrypted, "incorrect-key")).rejects.toThrow();
    const view = await getConnectorSettingsView(env, "sinopac");
    expect(view).toMatchObject({
      configured: true,
      credentialsComplete: true,
      sessionAvailable: true,
      publicConfig: null,
    });
    expect(JSON.stringify(view)).not.toMatch(
      /synthetic-|sessionCookies|password|captcha/,
    );

    await updateConnectorSettings(env, "sinopac", { account: "new-user" });
    const updated = await getConnectorSettings(env.DB, "sinopac");
    expect(await decryptJson(updated!.encrypted_config, key)).toEqual({
      ...credentials,
      account: "new-user",
    });
    expect(updated?.sync_cursor).toBeNull();
    expect(updated?.public_config).toBeNull();
    expect(updated?.id).toBe(stored?.id);
    expect(await getConnectorSettingsView(env, "sinopac")).toMatchObject({
      credentialsComplete: true,
      sessionAvailable: false,
    });
  });
});
