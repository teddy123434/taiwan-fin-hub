import { describe, expect, it } from "vitest";
import { parseRakutenDepositTransactions } from "../../../src/sources/rakuten/deposit-transactions";

const ACCOUNT_NO = "0081200000001234";
const ACCOUNT_SOURCE_ID = `bank:rakuten:${ACCOUNT_NO}:TWD`;
const deposits = [{ sourceId: ACCOUNT_SOURCE_ID, accountNo: ACCOUNT_NO }];

type Row = {
  sysDate: string;
  sysTime: string;
  /** 收入或支出（由測試以 signBy 決定 amtSign 的布林語意）。 */
  credit: boolean;
  amt: string;
  balance: string;
  txDesc: string;
  memo?: string;
  acctNo?: string;
  nickNameOrAcct?: string;
  pk?: string | null;
};

/** 網頁回應的欄位形狀（值皆為合成資料）；amtSign 的語意由 trueMeansCredit 決定。 */
function detail(row: Row, trueMeansCredit: boolean) {
  return {
    sysDate: row.sysDate,
    sysTime: row.sysTime,
    amtSign: trueMeansCredit ? row.credit : !row.credit,
    amt: row.amt,
    memo: row.memo ?? "",
    txDesc: row.txDesc,
    nickNameOrAcct: row.nickNameOrAcct ?? "",
    displayAccount: "",
    acctNo: row.acctNo ?? "",
    bankId: "",
    balance: row.balance,
    txPk: "",
    ...(row.pk === null ? {} : { pk: row.pk }),
    showAcctNo: "",
    commonAcct: false,
  };
}

function month(
  rowsOldestFirst: Row[],
  options: {
    trueMeansCredit?: boolean;
    order?: "newestFirst" | "oldestFirst";
    display?: Record<string, boolean>;
    queryAccountNo?: string;
  } = {},
) {
  const rows =
    (options.order ?? "newestFirst") === "newestFirst"
      ? [...rowsOldestFirst].reverse()
      : rowsOldestFirst;
  return {
    display: {
      dataEnd: true,
      dataLimit: false,
      noData: false,
      ...options.display,
    },
    accounts: [{ acctNo: ACCOUNT_NO, balance: "123,469" }],
    queryAccountNo: options.queryAccountNo ?? ACCOUNT_NO,
    txDetails: rows.map((row) => detail(row, options.trueMeansCredit ?? true)),
  };
}

// 合成的一個月：期初 100,000 → 轉入 30,000 → 利息 12 → 自動扣款 6,543
const SEPTEMBER: Row[] = [
  {
    sysDate: "2026/09/01",
    sysTime: "09:10",
    credit: true,
    amt: "30,000",
    balance: "130,000",
    txDesc: "他行轉入",
    memo: "薪資",
    acctNo: "0071234567890",
    nickNameOrAcct: "0071234567890",
    pk: "20260901091000001",
  },
  {
    sysDate: "2026/09/04",
    sysTime: "00:05",
    credit: true,
    amt: "12",
    balance: "130,012",
    txDesc: "存款利息",
    pk: "20260904000500002",
  },
  {
    sysDate: "2026/09/17",
    sysTime: "08:30",
    credit: false,
    amt: "6,543",
    balance: "123,469",
    txDesc: "自動扣款",
    acctNo: "9990001",
    pk: "20260917083000003",
  },
];

// 上個月：期初 90,000 → 轉入 20,000 → 自動扣款 6,543 → 餘額 103,457 → 消費 3,457 → 100,000
const AUGUST: Row[] = [
  {
    sysDate: "2026/08/03",
    sysTime: "10:00",
    credit: true,
    amt: "20,000",
    balance: "110,000",
    txDesc: "他行轉入",
    pk: "20260803100000011",
  },
  {
    sysDate: "2026/08/17",
    sysTime: "08:30",
    credit: false,
    amt: "6,543",
    balance: "103,457",
    txDesc: "自動扣款",
    pk: "20260817083000012",
  },
  {
    sysDate: "2026/08/25",
    sysTime: "13:45",
    credit: false,
    amt: "3,457",
    balance: "100,000",
    txDesc: "轉帳",
    pk: "20260825134500013",
  },
];

function summarize(result: ReturnType<typeof parseRakutenDepositTransactions>) {
  return result.transactions.map((tx) => [
    tx.postedDate,
    tx.amount,
    tx.description,
  ]);
}

describe("parseRakutenDepositTransactions direction", () => {
  it("derives direction from balance deltas when true means credit (newest first)", () => {
    const result = parseRakutenDepositTransactions(
      [month(SEPTEMBER, { trueMeansCredit: true })],
      deposits,
    );
    expect(summarize(result)).toEqual([
      ["2026-09-17", -6543, "自動扣款"],
      ["2026-09-04", 12, "存款利息"],
      ["2026-09-01", 30_000, "他行轉入 · 薪資"],
    ]);
    // 最新兩筆靠餘額差，最舊那筆靠同月學到的 amtSign 對應
    expect(result.stats.directionByBalance).toBe(2);
    expect(result.stats.directionByAmtSign).toBe(1);
    expect(result.stats.monthsSkipped).toBe(0);
  });

  it("does not assume the amtSign convention: the same rows with true meaning debit and oldest-first order give the same result", () => {
    const result = parseRakutenDepositTransactions(
      [month(SEPTEMBER, { trueMeansCredit: false, order: "oldestFirst" })],
      deposits,
    );
    expect(
      result.transactions.map((tx) => tx.amount).sort((a, b) => a - b),
    ).toEqual([-6543, 12, 30_000]);
    expect(result.stats.directionByBalance).toBe(2);
    expect(result.stats.directionByAmtSign).toBe(1);
  });

  it("skips the month (and reports it) when direction cannot be determined", () => {
    const result = parseRakutenDepositTransactions(
      [month([AUGUST[0]!])],
      deposits,
    );
    expect(result.transactions).toEqual([]);
    expect(result.stats).toMatchObject({
      monthsProvided: 1,
      monthsSkipped: 1,
      skipReasons: { direction_unknown: 1 },
    });
  });
});

describe("parseRakutenDepositTransactions fields", () => {
  const result = parseRakutenDepositTransactions([month(SEPTEMBER)], deposits);
  const byDescription = (text: string) =>
    result.transactions.find((tx) => tx.description?.startsWith(text))!;

  it("stores only the last four digits of the counterparty account, never the full number", () => {
    expect(byDescription("他行轉入").counterparty).toBe("****7890");
    expect(JSON.stringify(result.transactions)).not.toContain("0071234567890");
    // 暱稱空白時同樣只留末四碼；對手就是自己的帳號時不記對手
    expect(byDescription("自動扣款").counterparty).toBe("****0001");
    expect(byDescription("存款利息").counterparty).toBeUndefined();
    // accountId 是帳戶自己的 sourceId（既有慣例）；其餘欄位不得出現任何完整帳號
    const withoutAccountId = JSON.stringify(
      result.transactions.map(({ accountId: _accountId, ...rest }) => rest),
    );
    expect(withoutAccountId).not.toContain(ACCOUNT_NO);
  });

  it("dedupes rows that appear in more than one month response", () => {
    const overlapping = parseRakutenDepositTransactions(
      [month(SEPTEMBER), month(SEPTEMBER)],
      deposits,
    );
    expect(overlapping.transactions).toHaveLength(3);
  });
});
