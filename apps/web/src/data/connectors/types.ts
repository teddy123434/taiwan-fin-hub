import type { ConnectorId, QueuedSyncResponse } from "@taiwan-fin-hub/shared";

export type { ConnectorId, QueuedSyncResponse } from "@taiwan-fin-hub/shared";

export type SyncTarget = "default" | "investments" | "bank" | "trades";

export interface ConnectorSettings {
  connectorId: ConnectorId;
  configured: boolean;
  updatedAt?: string;
  publicConfig?: Record<string, unknown> | null;
  credentialsComplete?: boolean;
  sessionAvailable?: boolean;
  verificationPending?: boolean;
  verificationChannel?: "app" | "email" | "sms" | null;
  verificationExpiresAt?: string | null;
}

export interface SyncJobRow {
  id: string;
  connectorId: ConnectorId;
  configured: boolean;
  scope: string;
  enabled: boolean;
  intervalMinutes: number;
  nextRunAt: string;
  scheduleMode: "inherit" | "custom";
  preferredTime: string;
  preferredWeekdays: number[];
  lockedUntil: string | null;
  lockedBy: string | null;
  lockTrigger: "manual" | "scheduled" | null;
  lockScope: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastStatus: "success" | "failed" | "needs_user_action" | null;
  lastError: string | null;
  /** 最近一次失敗的 API 錯誤代碼；需要處理時用來接續驗證流程。 */
  lastErrorCode: string | null;
  updatedAt: string;
  running: boolean;
  runId: string | null;
  phase: string | null;
  lastProgressAt: string | null;
  retryAfterSeconds: number;
  /** 最近一次背景手動同步；電子發票與集保使用各自的 durable run，固定為 null。 */
  manualRun: ManualSyncRun | null;
}

export interface ManualSyncRun {
  id: string;
  status:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "needs_user_action"
    | "cancelled";
  errorCode: string | null;
  lastError: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface SyncScheduleSettings {
  intervalMinutes: number;
  preferredTime: string;
  preferredWeekdays: number[];
  timezone: "Asia/Taipei";
  updatedAt: string;
}

export interface ConnectorField<TKey extends string = string> {
  key: TKey;
  label: string;
  type: "text" | "password" | "number";
  placeholder?: string;
}
