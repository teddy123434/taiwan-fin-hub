import type {
  ScheduledSyncReport,
  SyncReportActivities,
} from "@taiwan-fin-hub/shared";
import { queryOptions } from "@tanstack/svelte-query";
import type { ApiClient } from "@/shared/api/client";
import { queryKeys } from "@/shared/api/query-keys";

type ApiProvider = () => ApiClient;

export const latestSyncReportQuery = (getApi: ApiProvider) =>
  queryOptions({
    queryKey: queryKeys.latestSyncReport,
    queryFn: () =>
      getApi().get<ScheduledSyncReport | null>("/api/sync-reports/latest"),
  });

export const syncReportActivitiesQuery = (
  getApi: ApiProvider,
  batchId: string,
  enabled: boolean,
) =>
  queryOptions({
    queryKey: queryKeys.syncReportActivities(batchId),
    enabled,
    queryFn: () =>
      getApi().get<SyncReportActivities>(
        `/api/sync-reports/${encodeURIComponent(batchId)}/activities`,
      ),
  });
