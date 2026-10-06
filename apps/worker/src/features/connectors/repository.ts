import type { ConnectorId } from "@taiwan-fin-hub/shared";
import { getConnectorSettings, upsertConnectorSettings } from "../../db";

export function findConnectorSettings(
  db: D1Database,
  connectorId: ConnectorId,
) {
  return getConnectorSettings(db, connectorId);
}

export function saveConnectorSettings(
  db: D1Database,
  input: {
    id: string;
    connectorId: ConnectorId;
    encryptedConfig: string;
    publicConfig: string | null;
    now: string;
  },
) {
  return upsertConnectorSettings(db, input);
}
