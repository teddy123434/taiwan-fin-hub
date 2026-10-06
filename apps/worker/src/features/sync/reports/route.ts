import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { honoFactory } from "../../../platform/hono";
import { jsonError } from "../../../platform/http";
import { validationHook } from "../../../platform/validation";
import { getReportActivityDetails } from "./activity-detail-service";
import { getLatestScheduledSyncReport } from "./repository";

export const syncReportRoutes = honoFactory.createApp();

syncReportRoutes.get("/sync-reports/latest", async (c) =>
  c.json(await getLatestScheduledSyncReport(c.env.DB)),
);

syncReportRoutes.get(
  "/sync-reports/:batchId/activities",
  zValidator(
    "param",
    z.object({
      batchId: z.string().min(1).max(200),
    }),
    validationHook("INVALID_REQUEST", "Invalid report."),
  ),
  async (c) => {
    const sources = await getReportActivityDetails(
      c.env.DB,
      c.req.valid("param").batchId,
    );
    return sources
      ? c.json({ sources })
      : jsonError("SYNC_REPORT_NOT_FOUND", "同步報告不存在。", 404);
  },
);
