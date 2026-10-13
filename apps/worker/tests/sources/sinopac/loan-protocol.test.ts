import { describe, expect, it } from "vitest";
import {
  fetchSinopacLoans,
  parseSinopacLoanAccountList,
  parseSinopacLoanInfo,
} from "../../../src/sources/sinopac/loan-protocol";
import { SinopacVerificationRequiredError } from "../../../src/sources/sinopac/verification-error";

// Synthetic only: the captured loan-list HAR omits RecordCount.
const accountList = (numbers: string[]) => [
  {
    Header: "SUCCESS",
    Message: null,
    RecordCount: Math.max(0, numbers.length - 1),
    SubInfo: numbers.map((AcctValue) => ({
      AcctText: "貸款帳戶",
      AcctValue,
      AcctValueFormat: "formatted-account-reference",
    })),
  },
];

const loanInfo = (overrides: Record<string, unknown> = {}) => [
  {
    Header: "SUCCESS",
    Message: null,
    SubInfo: [
      {
        BeginLoanDate: "2024/04/05",
        Currency: "TWD",
        LoanAcctCName: "貸款帳戶",
        LoanAmt: "1,000,000",
        LoanBalance: "493,828",
        LoanDate: "2024/04/05",
        LoanKind: "信用貸款",
        LoanRate: "2.07",
        MatureDate: "2030/04/05",
        PayName: "測試繳款人",
        Sub1_Sub2: "平均攤還本息",
        ...overrides,
      },
    ],
  },
];

const payDetail = (overrides: Record<string, unknown> = {}) => [
  {
    Header: "SUCCESS",
    Message: null,
    TopInfo: "<font>應繳金額總計1,234補充摘要567</font>",
    HeadInfo: [
      { FieldKey: "DataValue3", HeadText: "計息起日<br />計息止日" },
      { FieldKey: "DataValue5", HeadText: "繳息金額" },
    ],
    HeadInfo_2: [{ FieldKey: "DataValue6", HeadText: "現有本金餘額" }],
    SubInfo: [
      {
        DataValue3: "2026/09/12<br />2026/10/12",
        DataValue5: "840",
      },
    ],
    SubInfo_2: [{ DataValue6: "493,828" }],
    ...overrides,
  },
];

const listPath = "/ws/bank/loan/ws_loanaccount.ashx";
const infoPath = "/ws/bank/loan/ws_loaninfo.ashx";
const payPath = "/ws/bank/loan/ws_paydetail.ashx";

const success = (overrides: Record<string, unknown> = {}) => [
  {
    Header: "SUCCESS",
    Message: null,
    RecordCount: 0,
    SubInfo: [],
    ...overrides,
  },
];

describe("Sinopac loan protocol", () => {
  it("parses a complete list to hashed loan IDs without embedding the account number in the stable ID", () => {
    const accountNumber = "1234567890123456";
    const result = parseSinopacLoanAccountList(accountList([accountNumber]));

    expect(result.complete).toBe(true);
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]?.sourceId).toMatch(/^loan:sinopac:[0-9a-f]{64}$/);
    expect(result.accounts[0]?.sourceId).not.toContain(accountNumber);
    expect(result.accounts[0]?.accountSuffix).toBe("3456");
  });

  it("counts mismatched counts or malformed rows as failures while retaining valid rows", () => {
    const valid = accountList(["1234567890123456"])[0]!;
    const countMismatch = parseSinopacLoanAccountList([
      { ...valid, RecordCount: 4 },
    ]);
    const malformedRow = parseSinopacLoanAccountList([
      {
        ...valid,
        RecordCount: 1,
        SubInfo: [...valid.SubInfo, { AcctValue: "short" }],
      },
    ]);

    expect(countMismatch.complete).toBe(false);
    expect(countMismatch.accounts).toHaveLength(1);
    expect(countMismatch.failureCount).toBe(1);
    expect(malformedRow.complete).toBe(false);
    expect(malformedRow.accounts).toHaveLength(1);
    expect(malformedRow.failureCount).toBe(1);
    expect(parseSinopacLoanAccountList(success())).toMatchObject({
      complete: true,
      accounts: [],
    });
    expect(parseSinopacLoanAccountList([{ Header: "SUCCESS" }])).toMatchObject({
      complete: false,
      accounts: [],
    });
  });

  it("treats missing RecordCount as unknown completeness, not a parse failure", () => {
    const response = accountList(["1234567890123456", "6543210987654321"])[0]!;
    const { RecordCount: _unobservedCount, ...observedResponse } = response;

    expect(parseSinopacLoanAccountList([observedResponse])).toMatchObject({
      complete: false,
      failureCount: 0,
      accounts: expect.arrayContaining([
        expect.objectContaining({ accountSuffix: "3456" }),
        expect.objectContaining({ accountSuffix: "4321" }),
      ]),
    });
  });

  it("processes every valid loan row when the account-list RecordCount is missing", async () => {
    const observedList = accountList([
      "1234567890123456",
      "6543210987654321",
    ]).map(({ RecordCount: _recordCount, ...response }) => response);
    const result = await fetchSinopacLoans(async (path) => {
      if (path === listPath) return observedList;
      if (path === infoPath) return loanInfo();
      if (path === payPath) return payDetail();
      throw new Error("unexpected endpoint");
    });

    expect(result.loanOverviewComplete).toBe(false);
    expect(result.accountListFailures).toBe(0);
    expect(result.bankAccounts).toHaveLength(2);
    expect(result.bankBalanceSnapshots).toHaveLength(2);
    expect(result.bankBalanceSnapshots.map(({ balance }) => balance)).toEqual([
      -493_828, -493_828,
    ]);
  });

  it("maps confirmed credit-loan fields and stores the balance as a liability", () => {
    const account = parseSinopacLoanAccountList(
      accountList(["1234567890123456"]),
    ).accounts[0]!;
    const result = parseSinopacLoanInfo(
      account,
      loanInfo(),
      new Date("2026-10-10T02:00:00.000Z"),
    );

    expect(result?.account).toMatchObject({
      accountType: "loan",
      loanCategory: "personal",
      loanInterestRate: 2.07,
      openedDate: "2024-04-05",
      currency: "TWD",
    });
    expect(result?.account.accountName).toContain("信用貸款");
    expect(result?.snapshot).toMatchObject({
      balance: -493_828,
      currency: "TWD",
      sourceId: `${account.sourceId}:current`,
    });
    expect(JSON.stringify(result)).not.toContain("1234567890123456");
    expect(result?.account.raw).toMatchObject({
      sinopacLoan: {
        accountSuffix: "3456",
        sourceFields: {
          LoanAcctCName: "貸款帳戶",
          LoanAmt: "1,000,000",
          LoanDate: "2024/04/05",
          MatureDate: "2030/04/05",
          Sub1_Sub2: "平均攤還本息",
        },
      },
    });
    expect(JSON.stringify(result?.account.raw)).not.toContain("測試繳款人");
  });

  it.each([
    ["房屋貸款", "housing"],
    ["信用貸款", "personal"],
    ["其他", "other"],
  ] as const)("maps LoanKind %s to %s", (kind, category) => {
    const account = parseSinopacLoanAccountList(
      accountList(["1234567890123456"]),
    ).accounts[0]!;
    const result = parseSinopacLoanInfo(account, loanInfo({ LoanKind: kind }));

    expect(result?.account.loanCategory).toBe(category);
  });

  it("leaves an invalid optional field empty without losing other loan fields", () => {
    const account = parseSinopacLoanAccountList(
      accountList(["1234567890123456"]),
    ).accounts[0]!;
    const result = parseSinopacLoanInfo(
      account,
      loanInfo({ LoanRate: "invalid", BeginLoanDate: "invalid" }),
    );

    expect(result?.account).toMatchObject({
      accountType: "loan",
      loanCategory: "personal",
      currency: "TWD",
    });
    expect(result?.account).not.toHaveProperty("loanInterestRate");
    expect(result?.account).not.toHaveProperty("openedDate");
    expect(result?.snapshot?.balance).toBe(-493_828);
  });

  it("keeps a loan account when only the balance field cannot be parsed", () => {
    const account = parseSinopacLoanAccountList(
      accountList(["1234567890123456"]),
    ).accounts[0]!;
    const result = parseSinopacLoanInfo(
      account,
      loanInfo({ LoanBalance: "-" }),
    );

    expect(result?.account.loanCategory).toBe("personal");
    expect(result?.account.loanInterestRate).toBe(2.07);
    expect(result?.snapshot).toBeUndefined();
  });

  it("keeps other loan fields when Currency is invalid and omits the unqualified balance snapshot", () => {
    const account = parseSinopacLoanAccountList(
      accountList(["1234567890123456"]),
    ).accounts[0]!;
    const result = parseSinopacLoanInfo(account, loanInfo({ Currency: "" }));

    expect(result?.currencyValid).toBe(false);
    expect(result?.account.currency).toBe("");
    expect(result?.account.loanCategory).toBe("personal");
    expect(result?.account.loanInterestRate).toBe(2.07);
    expect(result?.account.raw).toMatchObject({
      sinopacLoan: { currencyParseFailed: true },
    });
    expect(result?.snapshot).toBeUndefined();
  });

  it("continues processing a loan when only its currency is invalid", async () => {
    const result = await fetchSinopacLoans(async (path) => {
      if (path === listPath) return accountList(["1234567890123456"]);
      if (path === infoPath) return loanInfo({ Currency: "" });
      if (path === payPath) return payDetail();
      throw new Error("unexpected endpoint");
    });

    expect(result.bankAccounts).toHaveLength(1);
    expect(result.bankAccounts[0]?.loanCategory).toBe("personal");
    expect(result.bankAccounts[0]?.loanInterestRate).toBe(2.07);
    expect(result.bankBalanceSnapshots).toEqual([]);
    expect(result.accountDetailFailures).toBe(1);
    expect(result.loanOverviewComplete).toBe(false);
  });

  it("uses the explicit TopInfo total label and never maps DataValue5 interest as total due", async () => {
    const calls: string[] = [];
    const result = await fetchSinopacLoans(async (path, _label, body) => {
      calls.push(path);
      if (path === listPath) return accountList(["1234567890123456"]);
      if (path === infoPath) return loanInfo();
      if (path === payPath) {
        expect(body.get("LNMAINACNO")).toBe("1234567890123456");
        expect(body.get("LNALTNO")).toBe("平均攤還本息");
        return payDetail();
      }
      throw new Error("unexpected endpoint");
    });

    expect(result.bankAccounts).toHaveLength(1);
    expect(result.bankBalanceSnapshots[0]).toMatchObject({
      paymentDueDate: "2026-10-12",
      loanPaymentAmount: 1_234,
    });
    expect(result.bankBalanceSnapshots[0]?.raw).toMatchObject({
      sinopacLoan: {
        paymentDetail: {
          interestAccrualStartDate: "2026-09-12",
          interestAccrualEndDate: "2026-10-12",
          interestPaymentAmount: 840,
          currentPrincipalBalance: 493_828,
        },
      },
    });
    expect(calls).toEqual([listPath, infoPath, payPath]);
  });

  it.each([
    ["missing numeric value", "<font>應繳金額總計未提供</font>"],
    ["different label", "<font>應繳總額合計1,234</font>"],
  ])(
    "leaves total payment missing for %s while retaining other parsed fields",
    async (_scenario, topInfo) => {
      const result = await fetchSinopacLoans(async (path) => {
        if (path === listPath) return accountList(["1234567890123456"]);
        if (path === infoPath) return loanInfo();
        if (path === payPath) return payDetail({ TopInfo: topInfo });
        throw new Error("unexpected endpoint");
      });

      expect(result.bankBalanceSnapshots[0]).toMatchObject({
        balance: -493_828,
        paymentDueDate: "2026-10-12",
      });
      expect(result.bankBalanceSnapshots[0]).not.toHaveProperty(
        "loanPaymentAmount",
      );
      expect(result.paymentDetailFailures).toBe(1);
      expect(result.loanOverviewComplete).toBe(false);
    },
  );

  it("does not map dates when the FieldKey or HeadText differs from the verified header", async () => {
    const result = await fetchSinopacLoans(async (path) => {
      if (path === listPath) return accountList(["1234567890123456"]);
      if (path === infoPath) return loanInfo();
      if (path === payPath)
        return payDetail({
          HeadInfo: [
            { FieldKey: "DataValue4", HeadText: "計息起日<br />計息止日" },
            { FieldKey: "DataValue5", HeadText: "繳息金額" },
          ],
        });
      throw new Error("unexpected endpoint");
    });

    expect(result.bankBalanceSnapshots[0]).not.toHaveProperty("paymentDueDate");
    expect(result.paymentDetailFailures).toBe(1);
  });

  it("continues other loans when one loan-info request fails", async () => {
    const result = await fetchSinopacLoans(async (path, _label, body) => {
      if (path === listPath)
        return accountList(["1234567890123456", "6543210987654321"]);
      const accountValue = body.get("AcctValue");
      if (path === infoPath && accountValue === "1234567890123456")
        throw new Error("redacted request failure");
      if (path === infoPath) return loanInfo({ LoanKind: "房屋貸款" });
      if (path === payPath) return payDetail();
      throw new Error("unexpected endpoint");
    });

    expect(result.bankAccounts).toHaveLength(1);
    expect(result.bankAccounts[0]?.loanCategory).toBe("housing");
    expect(result.bankBalanceSnapshots[0]?.balance).toBe(-493_828);
    expect(result.accountDetailFailures).toBe(1);
    expect(result.paymentDetailFailures).toBe(0);
    expect(result.loanOverviewComplete).toBe(false);
  });

  it("continues later loans when one loan payment API request fails", async () => {
    const accounts = ["1234567890123456", "6543210987654321"];
    const result = await fetchSinopacLoans(async (path, _label, body) => {
      if (path === listPath) return accountList(accounts);
      const accountValue = body.get("AcctValue");
      if (path === infoPath) return loanInfo();
      if (path === payPath && accountValue === accounts[0])
        throw new Error("redacted payment failure");
      if (path === payPath) return payDetail();
      throw new Error("unexpected endpoint");
    });

    expect(result.bankAccounts).toHaveLength(2);
    expect(result.bankBalanceSnapshots).toHaveLength(2);
    expect(result.bankBalanceSnapshots[0]).not.toHaveProperty(
      "loanPaymentAmount",
    );
    expect(result.bankBalanceSnapshots[1]).toMatchObject({
      paymentDueDate: "2026-10-12",
      loanPaymentAmount: 1_234,
    });
    expect(result.paymentDetailFailures).toBe(1);
    expect(result.loanOverviewComplete).toBe(false);
  });

  it("fails soft when the loan list request fails and does not claim a complete overview", async () => {
    const result = await fetchSinopacLoans(async () => {
      throw new Error("redacted list failure");
    });

    expect(result.bankAccounts).toEqual([]);
    expect(result.bankBalanceSnapshots).toEqual([]);
    expect(result.accountListFailures).toBe(1);
    expect(result.loanOverviewComplete).toBe(false);
  });

  it.each([
    ["account-list", listPath],
    ["loan-info", infoPath],
    ["payment-detail", payPath],
  ] as const)(
    "rethrows verification-required errors from %s requests",
    async (_stage, failedPath) => {
      const verificationError = new SinopacVerificationRequiredError(
        "synthetic verification required",
      );

      await expect(
        fetchSinopacLoans(async (path) => {
          if (path === failedPath) throw verificationError;
          if (path === listPath) return accountList(["1234567890123456"]);
          if (path === infoPath) return loanInfo();
          if (path === payPath) return payDetail();
          throw new Error("unexpected endpoint");
        }),
      ).rejects.toBe(verificationError);
    },
  );

  it("accepts an explicitly counted successful empty loan list", async () => {
    const result = await fetchSinopacLoans(async () => success());

    expect(result.loanOverviewComplete).toBe(true);
    expect(result.bankAccounts).toEqual([]);
    expect(result.bankBalanceSnapshots).toEqual([]);
    expect(result.accountListFailures).toBe(0);
  });

  it("accepts an empty loan list without RecordCount without failure or completeness proof", async () => {
    const [{ RecordCount: _recordCount, ...response }] = success();
    const result = await fetchSinopacLoans(async () => [response]);

    expect(result.loanOverviewComplete).toBe(false);
    expect(result.bankAccounts).toEqual([]);
    expect(result.bankBalanceSnapshots).toEqual([]);
    expect(result.accountListFailures).toBe(0);
  });

  it.each([
    ["API failure", [{ Header: "FAIL", Message: "error", SubInfo: [] }]],
    ["malformed success schema", [{ Header: "SUCCESS" }]],
  ])("counts a real loan-list %s", async (_scenario, response) => {
    const result = await fetchSinopacLoans(async () => response);

    expect(result.bankAccounts).toEqual([]);
    expect(result.accountListFailures).toBe(1);
    expect(result.loanOverviewComplete).toBe(false);
  });

  it("does not claim a complete overview when a loan payment API request fails", async () => {
    const result = await fetchSinopacLoans(async (path) => {
      if (path === listPath) return accountList(["1234567890123456"]);
      if (path === infoPath) return loanInfo();
      if (path === payPath) throw new Error("redacted payment API failure");
      throw new Error("unexpected endpoint");
    });

    expect(result.bankAccounts).toHaveLength(1);
    expect(result.paymentDetailFailures).toBe(1);
    expect(result.loanOverviewComplete).toBe(false);
  });
});
