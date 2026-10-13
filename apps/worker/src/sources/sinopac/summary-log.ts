export type SinopacSyncSummaryInput = {
  accountCount: number;
  snapshotCount: number;
  transactionCount: number;
  billCount: number;
  loanOverviewComplete: boolean;
  loanAccountListFailures: number;
  loanAccountDetailFailures: number;
  loanPaymentDetailFailures: number;
  loanAccountCount: number;
  loanSnapshotCount: number;
};

function safeCount(value: number) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function createSinopacLoanLogFields(input: SinopacSyncSummaryInput) {
  const loanAccountListFailures = safeCount(input.loanAccountListFailures);
  const loanAccountDetailFailures = safeCount(input.loanAccountDetailFailures);
  const loanPaymentDetailFailures = safeCount(input.loanPaymentDetailFailures);
  const loanAccountCount = safeCount(input.loanAccountCount);
  const loanFailureCount = safeCount(
    loanAccountListFailures +
      loanAccountDetailFailures +
      loanPaymentDetailFailures,
  );
  const loanStatus =
    loanAccountListFailures > 0 && loanAccountCount === 0
      ? "failed"
      : loanFailureCount > 0
        ? "partial"
        : loanAccountCount === 0
          ? "no_loans"
          : "success";

  return {
    loanStatus,
    loanAccountCount,
    loanSnapshotCount: safeCount(input.loanSnapshotCount),
    loanFailureCount,
  };
}

export function logSinopacSyncSummary(input: SinopacSyncSummaryInput) {
  const loanFields = createSinopacLoanLogFields(input);
  console.log(
    `[sync] sinopac/all: accounts=${safeCount(input.accountCount)} snapshots=${safeCount(input.snapshotCount)} transactions=${safeCount(input.transactionCount)} bills=${safeCount(input.billCount)} loanStatus=${loanFields.loanStatus} loanAccountCount=${loanFields.loanAccountCount} loanSnapshotCount=${loanFields.loanSnapshotCount} loanFailureCount=${loanFields.loanFailureCount}`,
  );
}
