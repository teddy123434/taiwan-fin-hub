import type { Env } from "../../platform/env";
import type { ConnectorId } from "@taiwan-fin-hub/shared";
import { getConnectorSettings } from "../../db";
import { NeedsUserActionError } from "./errors";
import { encryptJson } from "../../platform/crypto";
import {
  sensitiveConnectorConfig,
  serializePublicConnectorConfig,
} from "./connector-state";
import { configEncryptionKey } from "../../platform/config";

export async function requireConnectorSettings(
  env: Env["DB"],
  connectorId: ConnectorId,
) {
  const settings = await getConnectorSettings(env, connectorId);
  if (!settings) {
    throw new NeedsUserActionError(
      "Connector settings are required before sync.",
    );
  }
  return settings;
}

export async function encryptConnectorConfig(
  env: Env,
  connectorId: ConnectorId,
  config: object,
) {
  return encryptJson(
    sensitiveConnectorConfig(connectorId, config as Record<string, unknown>),
    configEncryptionKey(env),
  );
}

export function serializePublicConfig(
  connectorId: ConnectorId,
  config: object,
) {
  return serializePublicConnectorConfig(
    connectorId,
    config as Record<string, unknown>,
  );
}
