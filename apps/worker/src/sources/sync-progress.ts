import { AsyncLocalStorage } from "node:async_hooks";

/** 一般同步對使用者顯示的階段；電子發票與集保改由各自的 durable run 回報。 */
export type SyncProgressPhase = "login" | "fetching" | "saving";

type SyncProgressReporter = (phase: SyncProgressPhase) => void;

const reporter = new AsyncLocalStorage<SyncProgressReporter>();

export function runWithSyncProgress<T>(
  report: SyncProgressReporter,
  task: () => T,
): T {
  return reporter.run(report, task);
}

/** Best-effort；不在同步執行內呼叫時不做事，也不會讓同步失敗。 */
export function reportSyncProgress(phase: SyncProgressPhase) {
  reporter.getStore()?.(phase);
}
