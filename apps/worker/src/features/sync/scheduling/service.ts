import type { ConnectorId } from "@taiwan-fin-hub/shared";
import { nextSyncRunAt, type SyncScheduleMode } from "../../../db";
import { getActiveEinvoiceRun } from "../../../sources/einvoice/run-repository";
import { getActiveTdccRun } from "../../../sources/tdcc/run-repository";
import { durableRunState } from "../run-state";
import { listLatestManualSyncRuns } from "../manual-run-repository";
import {
  findDefaultSyncSchedule,
  findSyncJob,
  listInheritedSyncJobs,
  listSyncJobs,
  saveDefaultSyncSchedule,
  updateSyncJob,
} from "./repository";

export class DefaultSyncScheduleMissingError extends Error {}
export class SyncJobNotFoundError extends Error {}

export async function getDefaultSyncSchedule(db: D1Database) {
  const schedule = await findDefaultSyncSchedule(db);
  if (!schedule) throw new DefaultSyncScheduleMissingError();
  return schedule;
}

export async function setDefaultSyncSchedule(
  db: D1Database,
  input: {
    intervalMinutes: number;
    preferredTime: string;
    preferredWeekdays: number[];
  },
) {
  const now = new Date();
  const inheritedJobs = await listInheritedSyncJobs(db);
  await saveDefaultSyncSchedule(db, {
    ...input,
    updatedAt: now.toISOString(),
    inheritedJobs: inheritedJobs.map((job) => ({
      id: job.id,
      nextRunAt: nextSyncRunAt(
        input.intervalMinutes,
        input.preferredTime,
        now,
        job.nextRunAt,
        input.preferredWeekdays,
      ),
    })),
  });
  return {
    ...input,
    preferredWeekday: input.preferredWeekdays[0],
    timezone: "Asia/Taipei" as const,
    updatedAt: now.toISOString(),
  };
}

export async function getSyncJobs(db: D1Database) {
  const rows = await listSyncJobs(db);
  const now = new Date();
  const [activeEinvoiceRun, activeTdccRun, manualRuns] = await Promise.all([
    getActiveEinvoiceRun(db),
    getActiveTdccRun(db),
    listLatestManualSyncRuns(db),
  ]);
  const manualRunByConnector = new Map(
    manualRuns.map((run) => [run.connectorId, run]),
  );
  return rows.map(({ lockPhase, ...row }) => {
    const run =
      row.connectorId === "einvoice"
        ? activeEinvoiceRun
        : row.connectorId === "tdcc"
          ? activeTdccRun
          : null;
    const manualRun =
      row.scope === "all"
        ? (manualRunByConnector.get(row.connectorId) ?? null)
        : null;
    const locked = Boolean(row.lockedUntil && new Date(row.lockedUntil) > now);
    // 排隊中的背景手動同步尚未取得 connector lock，仍視為執行中。
    const queuedManual = !locked && manualRun?.status === "queued";
    const state = run ? durableRunState(run, now.getTime()) : null;
    return {
      ...row,
      configured: Boolean(row.configured),
      enabled: Boolean(row.enabled),
      lockScope: run ? ("scope" in run ? run.scope : "all") : row.lockScope,
      lockTrigger: run?.trigger ?? (queuedManual ? "manual" : row.lockTrigger),
      running: Boolean(run) || locked || queuedManual,
      runId:
        state?.runId ??
        (locked ? row.lockedBy : queuedManual ? manualRun.id : null),
      phase:
        state?.phase ??
        (locked ? (lockPhase ?? "processing") : queuedManual ? "queued" : null),
      lastProgressAt:
        state?.lastProgressAt ??
        (locked ? row.updatedAt : queuedManual ? manualRun.updatedAt : null),
      manualRun: manualRun && {
        id: manualRun.id,
        status: manualRun.status,
        errorCode: manualRun.errorCode,
        lastError: manualRun.lastError,
        createdAt: manualRun.createdAt,
        completedAt: manualRun.completedAt,
      },
      retryAfterSeconds:
        state?.retryAfterSeconds ??
        (locked
          ? Math.max(
              1,
              Math.ceil((Date.parse(row.lockedUntil!) - now.getTime()) / 1000),
            )
          : 0),
    };
  });
}

export type UpdateSyncJobInput = {
  enabled?: boolean;
  nextRunAt?: string;
  intervalMinutes?: number;
  preferredTime?: string;
  preferredWeekday?: number;
  preferredWeekdays?: number[];
  scheduleMode?: SyncScheduleMode;
};

export async function editSyncJob(
  db: D1Database,
  connectorId: ConnectorId,
  scope: string,
  input: UpdateSyncJobInput,
) {
  const job = await findSyncJob(db, connectorId, scope);
  if (!job) throw new SyncJobNotFoundError();
  const now = new Date();
  const scheduleMode = input.scheduleMode ?? job.schedule_mode;
  const defaultSchedule =
    scheduleMode === "inherit" ? await getDefaultSyncSchedule(db) : null;
  const intervalMinutes =
    defaultSchedule?.intervalMinutes ??
    input.intervalMinutes ??
    job.interval_minutes;
  const preferredTime =
    defaultSchedule?.preferredTime ?? input.preferredTime ?? job.preferred_time;
  const preferredWeekdays =
    defaultSchedule?.preferredWeekdays ??
    input.preferredWeekdays ??
    (input.preferredWeekday !== undefined
      ? [input.preferredWeekday]
      : job.preferred_weekdays);
  const scheduleChanged =
    input.scheduleMode !== undefined ||
    input.intervalMinutes !== undefined ||
    input.preferredTime !== undefined ||
    input.preferredWeekday !== undefined ||
    input.preferredWeekdays !== undefined;
  const nextRunAt =
    input.nextRunAt ??
    (scheduleChanged || input.enabled === true
      ? nextSyncRunAt(
          intervalMinutes,
          preferredTime,
          now,
          job.next_run_at,
          preferredWeekdays,
        )
      : job.next_run_at);
  if (
    !(await updateSyncJob(db, connectorId, scope, {
      enabled: input.enabled,
      nextRunAt,
      intervalMinutes,
      scheduleMode,
      preferredTime,
      preferredWeekdays,
      updatedAt: now.toISOString(),
    }))
  )
    throw new SyncJobNotFoundError();
  return {
    success: true,
    connectorId,
    scope,
    enabled: input.enabled ?? Boolean(job.enabled),
    intervalMinutes,
    preferredTime,
    preferredWeekday: preferredWeekdays[0],
    preferredWeekdays,
    scheduleMode,
    nextRunAt,
  };
}
