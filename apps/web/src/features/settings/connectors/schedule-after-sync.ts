import type { ConnectorId, SyncJobRow } from "@/data/connectors/types";

export function shouldEnableScheduleAfterFirstSync(
  connectorId: ConnectorId,
  job: Pick<SyncJobRow, "enabled" | "lastSuccessAt"> | undefined,
) {
  return (
    (connectorId === "sinopac" ||
      connectorId === "taishin" ||
      connectorId === "obank" ||
      connectorId === "megabank") &&
    job?.enabled === false &&
    job.lastSuccessAt === null
  );
}
