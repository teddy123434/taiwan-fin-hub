import { describe, expect, it } from "vitest";
import {
  buildEsunCreditTimelinePages,
  readEsunCardBalances,
  type EsunSnapshot,
} from "../../../src/sources/esun/portal";
import {
  normalizeEsunTimelineTransactions,
  type EsunTimelinePage,
  type EsunTimelineTransaction,
} from "../../../src/sources/esun/connector";

function page(transactions: EsunTimelineTransaction[]): EsunTimelinePage {
  return {
    timelineList: [
      {
        year: "2026",
        month: "07",
        txnList: transactions,
      },
    ],
  };
}

function transaction(
  acfg: string,
  overrides: Partial<EsunTimelineTransaction> = {},
): EsunTimelineTransaction {
  return {
    payCur: "TWD",
    payAmt: "252",
    storeName: "全支付﹘全聯",
    consumerDt: "07/05",
    cardNo: "****1204",
    acfg,
    ...overrides,
  };
}

describe("E.SUN bill payment status", () => {
  it.each([
    [true, true, 12040],
    [false, undefined, 27248],
    [undefined, undefined, 27248],
  ])(
    "maps creditCardFeePaid %s to %s and excludes paid debt",
    (overviewPaid, isPaid, outstanding) => {
      const snapshot: EsunSnapshot = {
        hasCreditCard: true,
        cardOverview: {
          resultCode: "0000",
          resultBody: {
            creditCardFeePaid: overviewPaid,
            currentStatement: [{ currency: "TWD", totalAmountDue: "15,208" }],
            nextStatement: [{ currency: "TWD", unpostedAmount: "12,040" }],
          },
        },
        billSummary: { body: { billInfo: {} } },
        billPeriod: "202608",
        realtime: {},
        creditHistory: [],
        twDeposits: [],
        frDeposits: [],
      };

      expect(readEsunCardBalances(snapshot)).toMatchObject({
        statementBalance: 15208,
        outstanding,
        isPaid,
      });
    },
  );

  it.each([
    [15208, 0],
    [0, 0],
    [-137, -137],
  ])(
    "preserves credits when a paid statement of %s has no new purchases",
    (statementBalance, outstanding) => {
      const snapshot: EsunSnapshot = {
        hasCreditCard: true,
        cardOverview: {
          resultCode: "0000",
          resultBody: {
            creditCardFeePaid: true,
            currentStatement: [
              { currency: "TWD", totalAmountDue: statementBalance },
            ],
          },
        },
        billSummary: { body: { billInfo: {} } },
        billPeriod: "202608",
        realtime: {},
        creditHistory: [],
        twDeposits: [],
        frDeposits: [],
      };

      expect(readEsunCardBalances(snapshot)).toMatchObject({
        statementBalance,
        outstanding,
        isPaid: true,
      });
    },
  );
});

describe("E.SUN credit card timeline normalization", () => {
  it("collapses pending and posted lifecycle copies into one stable transaction", () => {
    const rows = normalizeEsunTimelineTransactions([
      page([transaction("未入帳"), transaction("已入帳")]),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].sourceId).toBe(
      "2026-07-05T00:00:00.000Z:credit:esun:1204:全支付﹘全聯:252:TWD:1",
    );
    expect(rows[0]).toMatchObject({
      amount: -252,
      status: "posted",
      authorizedAt: "2026-07-05",
      postedDate: "2026-07-05T00:00:00.000Z",
    });
    expect((rows[0].raw as EsunTimelineTransaction).acfg).toBe("已入帳");
  });

  it("keeps negative history amounts as refunds instead of purchases", () => {
    const rows = normalizeEsunTimelineTransactions(
      buildEsunCreditTimelinePages({
        realtime: { body: { transList: [] } },
        creditHistory: [
          {
            body: {
              transList: [
                {
                  year: "2026",
                  month: "09",
                  transDetailList: [
                    {
                      merchantName: "優食台灣股份有限公司",
                      cardNo: "4751-XXXX-XXXX-0412",
                      transMonthDay: "0906",
                      paymentAmount: 199,
                      paymentCurrency: "TWD",
                      statusName: "已入帳",
                    },
                    {
                      merchantName: "優食台灣股份有限公司",
                      cardNo: "4751-XXXX-XXXX-0412",
                      transMonthDay: "0906",
                      paymentAmount: -199,
                      paymentCurrency: "TWD",
                      statusName: "已入帳",
                    },
                  ],
                },
              ],
            },
          },
        ],
      }),
    );

    expect(rows.map((row) => row.amount).sort((a, b) => a - b)).toEqual([
      -199, 199,
    ]);
  });
});
