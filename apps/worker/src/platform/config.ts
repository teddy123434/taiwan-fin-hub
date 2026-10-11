import type { Env } from "./env";

export function configEncryptionKey(env: Env) {
  if (!env.CONFIG_ENCRYPTION_KEY) {
    throw new Error(
      "CONFIG_ENCRYPTION_KEY is required for connector settings and sync.",
    );
  }
  if (env.CONFIG_ENCRYPTION_KEY === "auto") {
    const generatedKey = env.GENERATED_CONFIG_ENCRYPTION_KEY;
    if (!generatedKey || generatedKey === "auto") {
      throw new Error(
        "CONFIG_ENCRYPTION_KEY=auto requires GENERATED_CONFIG_ENCRYPTION_KEY. Use npm run deploy to initialize it; if encrypted data already exists, restore the original key.",
      );
    }
    return generatedKey;
  }
  return env.CONFIG_ENCRYPTION_KEY;
}
