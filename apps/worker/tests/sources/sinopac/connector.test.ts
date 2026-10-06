import { describe, expect, it } from "vitest";
import { parseSinopacCardData } from "../../../src/sources/sinopac/connector";

const summaryPayload = [
  {
    Header: "SUCCESS",
    Message: null,
    CreditSum: [
      { DataText: "卡號", DataValue: "****1234" },
      { DataText: "永久信用額度", DataValue: "200,000" },
      { DataText: "剩餘可用額度", DataValue: "168,500" },
      { DataText: "本期應繳金額", DataValue: "12,345" },
      { DataText: "最低應繳金額", DataValue: "1,234" },
      { DataText: "繳款截止日", DataValue: "115/08/05" },
      { DataText: "結帳日", DataValue: "115/07/15" },
    ],
  },
];

const billPayload = [
  {
    Header: "SUCCESS",
    Message: null,
    CreditDetail: [
      {
        DataText1: "帳單月份",
        DataValue1: "115/07",
        DataText2: "帳單金額",
        DataValue2: "12,345",
        DataText3: "最低應繳",
        DataValue3: "1,234",
        DataText4: "繳款截止日",
        DataValue4: "115/08/05",
        DataText5: "幣別",
        DataValue5: "TWD",
      },
    ],
  },
];

describe("sinopac App JSON parser", () => {
  it.each([
    ["0", -10000, false],
    ["3000", -7000, false],
    ["10000", 0, true],
    ["12000", 2000, true],
    ["-", -10000, false],
    ["", undefined, undefined],
    [undefined, undefined, undefined],
  ])(
    "uses per-currency statement and payment amounts (%s)",
    (paid, balance, isPaid) => {
      const result = parseSinopacCardData(
        {
          summary: summaryPayload,
          bills: billPayload,
          accountingInfo: {
            Result: {
              BaseData: { STMTDATE: "20260723", DUEDATE: "20260807" },
              BillAmounts: [
                {
                  CurrencyName: "日圓",
                  CURRBAL: "10,000",
                  DUEAMT: "2,000",
                  TotalPaymentAmt: paid,
                },
              ],
            },
          },
        },
        new Date("2026-07-25T00:00:00Z"),
      );
      expect(result.bankAccounts.some((item) => item.currency === "JPY")).toBe(
        true,
      );
      expect(
        result.creditCardBills.find((item) => item.currency === "JPY"),
      ).toMatchObject({
        statementAmount: 10000,
        minimumPayment: 2000,
        isPaid,
        paymentDueDate: "2026-08-07",
        statementClosingDate: "2026-07-23",
      });
      const snapshot = result.bankBalanceSnapshots.find(
        (item) => item.currency === "JPY",
      );
      if (balance === undefined) expect(snapshot).toBeUndefined();
      else expect(snapshot).toMatchObject({ balance, statementBalance: 10000 });
    },
  );

  it("銀行的未繳標記建立臺外幣欠款與待繳狀態，不沿用上一期繳款", () => {
    const result = parseSinopacCardData({
      summary: summaryPayload,
      bills: billPayload,
      accountingInfo: {
        Result: {
          BaseData: { STMTDATE: "20260723", DUEDATE: "20260807" },
          BillAmounts: [
            { CurrencyCode: "000", CURRBAL: "2,000", DUEAMT: "500" },
            { CurrencyCode: "392", CURRBAL: "10,000.00", DUEAMT: "2,000.00" },
          ].map((bill) => ({
            ...bill,
            TotalPaymentAmt: "-",
            PaymentRecords: [],
            LastPaymentDate: "2026/07/07",
            LastPaymentAmt: "20,000",
            PREVPAYAMT: "20,000",
          })),
        },
      },
    });
    expect(
      result.creditCardBills.filter((bill) => bill.billingPeriod === "2026-07"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          currency: "TWD",
          paidAmount: 0,
          isPaid: false,
        }),
        expect.objectContaining({
          currency: "JPY",
          paidAmount: 0,
          isPaid: false,
        }),
      ]),
    );
    expect(result.bankBalanceSnapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          currency: "TWD",
          balance: -2000,
          noPaymentNeeded: false,
        }),
        expect.objectContaining({
          currency: "JPY",
          balance: -10000,
          noPaymentNeeded: false,
        }),
      ]),
    );
  });

  it("rejects malformed accounting data instead of reporting an empty balance", () => {
    expect(() =>
      parseSinopacCardData({
        summary: summaryPayload,
        bills: billPayload,
        accountingInfo: { Result: {} },
      }),
    ).toThrow("帳務資訊格式不完整");
  });

  it("preserves a negative summary without cumulative payment information", () => {
    const result = parseSinopacCardData({
      bills: [],
      summary: [
        {
          CreditSum: [
            { DataText: "本期應繳金額", DataValue: "-137" },
            { DataText: "繳款狀態", DataValue: "無需繳款" },
          ],
        },
      ],
      accountingInfo: {
        Result: {
          BaseData: { STMTDATE: "20260723", DUEDATE: "20260807" },
          BillAmounts: [
            { CurrencyCode: "000", CURRBAL: "-137", TotalPaymentAmt: "-" },
          ],
        },
      },
    });
    expect(result.creditCardBills[0]).toMatchObject({
      statementAmount: -137,
      isPaid: true,
    });
    expect(result.bankBalanceSnapshots[0]).toMatchObject({
      balance: 137,
      statementBalance: -137,
      noPaymentNeeded: true,
    });
  });

  it("keeps unbilled JPY liability when the current statement contains only TWD", () => {
    const result = parseSinopacCardData({
      summary: summaryPayload,
      bills: billPayload,
      accountingInfo: {
        Result: {
          BaseData: { STMTDATE: "2026/08/23", DUEDATE: "2026/09/07" },
          BillAmounts: [
            { CurrencyCode: "000", CURRBAL: "820", TotalPaymentAmt: "820" },
          ],
        },
      },
      latest: { Result: { Items: [] } },
      outstanding: {
        Result: {
          Detail: [
            {
              CurrencyCode: "392",
              TXDATE: "2026/09/01",
              DEDATE: "2026/09/02",
              AMT: "100",
              MEMO: "測試消費",
            },
          ],
          SubTotal: [
            { CurrencyCode: "392", SubTotalAmt: "39,712.00", Count: 26 },
          ],
        },
      },
    });
    const snapshot = result.bankBalanceSnapshots.find(
      (row) => row.currency === "JPY",
    );
    expect(snapshot).toMatchObject({ balance: -39712 });
    expect(snapshot?.statementBalance).toBeUndefined();
    expect(snapshot?.paymentDueDate).toBeUndefined();
    expect(result.creditCardBills.some((row) => row.currency === "JPY")).toBe(
      false,
    );
    expect(
      result.bankBalanceSnapshots.find((row) => row.currency === "TWD")
        ?.balance,
    ).toBe(0);
  });
});
