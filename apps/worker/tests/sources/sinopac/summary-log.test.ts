import { describe, expect, it, vi } from "vitest";
import { logSinopacSyncSummary } from "../../../src/sources/sinopac/summary-log";

describe("永豐既有 totals log", () => {
  it("保留原始摘要欄位，只追加安全貸款狀態與計數", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      logSinopacSyncSummary({
        accountCount: 4,
        snapshotCount: 5,
        transactionCount: 12,
        billCount: 2,
        loanOverviewComplete: false,
        loanAccountListFailures: 0,
        loanAccountDetailFailures: 1,
        loanPaymentDetailFailures: 0,
        loanAccountCount: 1,
        loanSnapshotCount: 0,
        account: "PRIVATE_ACCOUNT_SENTINEL",
        balance: 987654321,
        date: "2099-12-31",
        html: "<html>PRIVATE_HTML_SENTINEL</html>",
        responseBody: "PRIVATE_RESPONSE_SENTINEL",
        cookie: "PRIVATE_COOKIE_SENTINEL",
        session: "PRIVATE_SESSION_SENTINEL",
        token: "PRIVATE_TOKEN_SENTINEL",
        ocr: "PRIVATE_OCR_SENTINEL",
      } as never);

      expect(log).toHaveBeenCalledTimes(1);
      const message = String(log.mock.calls[0]?.[0]);
      expect(message).toBe(
        "[sync] sinopac/all: accounts=4 snapshots=5 transactions=12 bills=2 loanStatus=partial loanAccountCount=1 loanSnapshotCount=0 loanFailureCount=1",
      );
      expect(message).not.toContain("sinopac_sync_finished");
      expect(message).not.toContain("sync_execution");
      for (const marker of [
        "PRIVATE_",
        "987654321",
        "2099-12-31",
        "<html>",
        "responseBody",
      ]) {
        expect(message).not.toContain(marker);
      }
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    [true, 0, 0, "no_loans", 0, 0, 0],
    [true, 2, 0, "success", 0, 0, 0],
    [false, 0, 1, "failed", 1, 0, 0],
    [false, 0, 0, "no_loans", 0, 0, 0],
    [false, 2, 0, "success", 0, 0, 0],
    [true, 1, 1, "partial", 1, 0, 0],
    [false, 2, 0, "partial", 1, 0, 1],
  ] as const)(
    "只把實際失敗計入摘要 (complete=%s, accounts=%s, listFailures=%s)",
    (
      loanOverviewComplete,
      loanAccountCount,
      loanAccountListFailures,
      expected,
      expectedFailureCount,
      loanAccountDetailFailures,
      loanPaymentDetailFailures,
    ) => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        logSinopacSyncSummary({
          accountCount: loanAccountCount,
          snapshotCount: 0,
          transactionCount: 0,
          billCount: 0,
          loanOverviewComplete,
          loanAccountListFailures,
          loanAccountDetailFailures,
          loanPaymentDetailFailures,
          loanAccountCount,
          loanSnapshotCount: 0,
        });
        const message = String(log.mock.calls[0]?.[0]);
        expect(message).toContain(`loanStatus=${expected}`);
        expect(message).toContain(`loanFailureCount=${expectedFailureCount}`);
      } finally {
        log.mockRestore();
      }
    },
  );
});
