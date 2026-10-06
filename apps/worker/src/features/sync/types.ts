import type { ConnectorId, SyncNewRecordCounts } from "@taiwan-fin-hub/shared";

export type SyncScope = "all" | "investments" | "bank" | "trades";

export const SYNC_SCOPE_ALL = "all";

export const TDCC_SCOPE_INVESTMENTS = "investments";

export const TDCC_SCOPE_BANK = "bank";

export const TDCC_SCOPE_TRADES = "trades";

export type SyncOutcome = {
  success: true;
  connectorId: ConnectorId;
  scope: SyncScope;
  records: number;
  newRecords: SyncNewRecordCounts;
  cursorUpdated: boolean;
  detailRecords?: number;
};
