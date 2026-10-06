import type {
  BankAccount,
  BankBalanceSnapshot,
  BankTransaction,
} from "@taiwan-fin-hub/shared";
import { z } from "zod";
import {
  parseRakutenDepositTransactions,
  type RakutenTransactionStats,
} from "./deposit-transactions";

/**
 * 樂天國際銀行網銀瀏覽器工作階段設定。
 *
 * 由於網銀 session 幾分鐘便會失效，每次同步皆獨立登入；`browserSessionId`／
 * `captcha` 僅用於人工輸入之一次性 challenge state，成功或失敗後皆會清除；
 * schema 刻意不宣告 `sessionCookies`／`sessionCreatedAt`／`captchaDigitCount`。
 */
export const rakutenConfigSchema = z.object({
  userId: z.string().min(1).max(10).optional(),
  account: z.string().min(1).max(12).optional(),
  password: z.string().min(1).max(12).optional(),
  browserSessionId: z.string().max(256).optional(),
  browserSessionExpiresAt: z.string().optional(),
  captcha: z
    .string()
    .regex(/^[A-Za-z0-9]{4}$/)
    .optional(),
});

export type RakutenConfig = z.infer<typeof rakutenConfigSchema>;

export function parseRakutenConfig(config: unknown): RakutenConfig {
  return rakutenConfigSchema.parse(config);
}

/** 解析器輸入：首頁 API JSON 優先，取不到時改用頁面文字。 */
export type RakutenPayloads = {
  /** 首頁 API（CHMQU0001）回應，含 depositInfo。 */
  dashboardPayload?: unknown;
  /** 「臺幣存款」頁面文字，存款 JSON 取不到時的備援。 */
  depositPageText?: string;
  /**
   * 臺幣活存明細 API（CTWQU0001/010 當月、CTWQU0001/011 指定月份）的回應，
   * 每個元素是一個月份的 rsData；沒有就不產生交易。
   */
  depositTxnPayloads?: unknown[];
};

export type RakutenData = {
  bankAccounts: Array<Omit<BankAccount, "id" | "connectorId">>;
  bankBalanceSnapshots: Array<Omit<BankBalanceSnapshot, "id" | "connectorId">>;
  bankTransactions: Array<Omit<BankTransaction, "id" | "connectorId">>;
  /** 交易解析的筆數統計（只有數字與原因代碼），供 connector 記錄 log。 */
  transactionStats: RakutenTransactionStats;
};

/**
 * 餘額快照 ID 帶上日期（UTC，與淨值歷史取日期的方式一致）：每天保留一筆，
 * 同一天多次同步只覆寫當天那筆，淨值歷史才有逐日的樂天餘額。
 */
function snapshotSourceId(base: string, asOfAt: string): string {
  return `${base}:${asOfAt.slice(0, 10)}`;
}

type AccountDraft = Omit<BankAccount, "id" | "connectorId">;
type SnapshotDraft = Omit<BankBalanceSnapshot, "id" | "connectorId">;
type ParsedAccount = {
  account: AccountDraft;
  snapshot: SnapshotDraft;
  /** 存款帳號（只用於比對活存明細屬於哪個帳戶，不寫入交易）。 */
  depositAccountNo?: string;
};

/** 存款優先使用 JSON，JSON 沒有解析出資料才改用頁面文字。 */
export function parseRakutenData(
  payloads: RakutenPayloads,
  now = new Date(),
): RakutenData {
  const asOfAt = now.toISOString();
  const depositsFromJson = depositAccountsFromPayload(
    payloads.dashboardPayload,
    asOfAt,
  );
  const deposits =
    depositsFromJson.length > 0
      ? depositsFromJson
      : depositAccountsFromText(payloads.depositPageText, asOfAt);

  const { transactions, stats } = parseRakutenDepositTransactions(
    payloads.depositTxnPayloads ?? [],
    deposits.flatMap((item) =>
      item.depositAccountNo
        ? [
            {
              sourceId: item.account.sourceId,
              accountNo: item.depositAccountNo,
            },
          ]
        : [],
    ),
  );
  return {
    bankAccounts: deposits.map((item) => item.account),
    bankBalanceSnapshots: deposits.map((item) => item.snapshot),
    bankTransactions: transactions,
    transactionStats: stats,
  };
}

function depositAccountsFromPayload(
  payload: unknown,
  asOfAt: string,
): ParsedAccount[] {
  return parseDepositPayload(payload).map(({ accountNo, entry, balance }) => {
    const sourceId = `bank:rakuten:${accountNo}:TWD`;
    return {
      depositAccountNo: accountNo,
      account: {
        sourceId,
        institutionName: "樂天國際銀行",
        accountName: entry.showAcctNo
          ? `樂天活儲 (${String(entry.showAcctNo)})`
          : "樂天活儲",
        accountType: "savings",
        currency: "TWD",
        raw: {
          accountType: "savings",
          riskType: entry.riskType,
          rate: entry.rate,
        },
      },
      snapshot: {
        accountId: sourceId,
        sourceId: snapshotSourceId(`snapshot:rakuten:${accountNo}:TWD`, asOfAt),
        balance,
        currency: "TWD",
        asOfAt,
        raw: { balance, rateAmount: entry.rateAmount },
      },
    };
  });
}

function depositAccountsFromText(
  text: string | undefined,
  asOfAt: string,
): ParsedAccount[] {
  const deposit = text ? parseDepositText(text) : undefined;
  if (!deposit) return [];
  const sourceId = `bank:rakuten:${deposit.accountNo}:TWD`;
  return [
    {
      depositAccountNo: deposit.accountNo,
      account: {
        sourceId,
        institutionName: "樂天國際銀行",
        accountName: "樂天活儲",
        accountType: "savings",
        currency: "TWD",
        raw: { accountType: "savings" },
      },
      snapshot: {
        accountId: sourceId,
        sourceId: snapshotSourceId(
          `snapshot:rakuten:${deposit.accountNo}:TWD`,
          asOfAt,
        ),
        balance: deposit.balance,
        currency: "TWD",
        asOfAt,
        raw: { balance: deposit.balance },
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// 存款 JSON 解析（白名單）
// ---------------------------------------------------------------------------

/** 樂天國際商業銀行的金融機構代碼。 */
const RAKUTEN_BANK_CODE = "826";
const BALANCE_KEYS = [
  "balance",
  "ntdCurrBal",
  "acctBal",
  "currBal",
  "totalBal",
] as const;

type JsonRecord = Record<string, unknown>;

type RakutenDeposit = {
  accountNo: string;
  balance: number;
  entry: JsonRecord;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function accountNoOf(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

/** 比對用：忽略帳號中的空白與連字號。 */
function comparableAccountNo(value: string): string {
  return value.replace(/[\s-]/g, "");
}

function bankCodeOf(entry: JsonRecord): string {
  return accountNoOf(entry.bankNo ?? entry.bankCode);
}

/** 明確標示為樂天本行（銀行代碼 826 或銀行名稱含「樂天」）。 */
function isExplicitRakutenEntry(entry: JsonRecord): boolean {
  const bankCode = bankCodeOf(entry);
  const bankName = accountNoOf(entry.bankName);
  return (
    bankCode.startsWith(RAKUTEN_BANK_CODE) ||
    (bankName !== "" && bankName.includes("樂天"))
  );
}

/** 他行／轉入對手帳號標記：第二道防線，任何一項成立就排除。 */
function isForeignEntry(entry: JsonRecord): boolean {
  const bankCode = bankCodeOf(entry);
  if (
    bankCode &&
    !bankCode.startsWith(RAKUTEN_BANK_CODE) &&
    bankCode !== "0" &&
    bankCode !== "000"
  ) {
    return true;
  }
  const bankName = accountNoOf(entry.bankName);
  if (bankName && !bankName.includes("樂天")) return true;
  const currency = accountNoOf(
    entry.currency ?? entry.cur ?? entry.curr ?? entry.ccy,
  );
  if (currency && !/^(TWD|NTD)$/i.test(currency)) return true;
  return (
    entry.isOtherBank === true ||
    entry.isOther === true ||
    entry.otherBankFlag === true ||
    entry.otherBankFlag === "1" ||
    entry.otherBankFlag === "Y" ||
    entry.isCounterparty === true ||
    entry.isTxCounterparty === true ||
    entry.isTransferAccount === true
  );
}

/** 依序找第一個有效的有限數字餘額（接受千分位字串）；全部無效回傳 undefined。 */
function balanceOf(entry: JsonRecord): number | undefined {
  for (const key of BALANCE_KEYS) {
    const value = entry[key];
    if (value === undefined || value === null) continue;
    const text =
      typeof value === "number"
        ? String(value)
        : String(value).replace(/[\s,]/g, "");
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) continue;
    const amount = Number(text);
    if (Number.isFinite(amount)) return amount;
  }
  return undefined;
}

/**
 * 從首頁 dashboard payload 解析臺幣活存帳戶，採白名單：
 *
 * - payload 有主帳號（`depositInfo.acctNo` 或 `acctNo`）時，只接受該帳號，
 *   或明確標示為樂天本行（銀行代碼 826／名稱含「樂天」）的帳號。
 * - 沒有主帳號時，只接受明確標示為樂天本行的帳號；都沒有標示時，只有在
 *   恰好一筆候選帳號時才接受，多筆無法分辨就一律不收。
 * - 他行標記（銀行代碼、名稱、幣別、各種 flag）先行排除，作為第二道防線。
 */
function parseDepositPayload(payload: unknown): RakutenDeposit[] {
  if (!isRecord(payload)) return [];
  const depositInfo = isRecord(payload.depositInfo)
    ? payload.depositInfo
    : undefined;
  const primaryHolder = [depositInfo, payload].find(
    (holder): holder is JsonRecord =>
      holder !== undefined && accountNoOf(holder.acctNo) !== "",
  );
  const primaryAcctNo = primaryHolder
    ? comparableAccountNo(accountNoOf(primaryHolder.acctNo))
    : "";

  const listed = Array.isArray(depositInfo?.depAccounts)
    ? depositInfo.depAccounts
    : Array.isArray(payload.depAccounts)
      ? payload.depAccounts
      : [];
  let candidates = listed.filter(isRecord);
  if (candidates.length === 0) {
    const single = [depositInfo?.depAccount, payload.depAccount].find(isRecord);
    candidates = single ? [single] : primaryHolder ? [primaryHolder] : [];
  }

  const eligible = candidates.filter(
    (entry) => accountNoOf(entry.acctNo) !== "" && !isForeignEntry(entry),
  );
  let accepted: JsonRecord[];
  if (primaryAcctNo) {
    accepted = eligible.filter(
      (entry) =>
        comparableAccountNo(accountNoOf(entry.acctNo)) === primaryAcctNo ||
        isExplicitRakutenEntry(entry),
    );
    // 清單裡找不到主帳號時，改用帶有主帳號與餘額的那一層本身
    if (
      accepted.length === 0 &&
      primaryHolder &&
      balanceOf(primaryHolder) !== undefined
    ) {
      accepted = [primaryHolder];
    }
  } else {
    const explicit = eligible.filter(isExplicitRakutenEntry);
    accepted =
      explicit.length > 0 ? explicit : eligible.length === 1 ? eligible : [];
  }

  const deposits: RakutenDeposit[] = [];
  const seen = new Set<string>();
  for (const entry of accepted) {
    const accountNo = accountNoOf(entry.acctNo);
    const key = comparableAccountNo(accountNo);
    if (seen.has(key)) continue;
    // 沒有有效餘額就略過，不寫入 0 或 NaN 的錯誤快照；確認有效後才標記已處理，
    // 同一帳號後面若還有有效的候選資料仍會採用。
    const balance = balanceOf(entry);
    if (balance === undefined) continue;
    seen.add(key);
    deposits.push({ accountNo, balance, entry });
  }
  return deposits;
}

// ---------------------------------------------------------------------------
// 頁面文字解析（JSON 取不到時的備援）
// ---------------------------------------------------------------------------
function parseDepositText(
  text: string,
): { accountNo: string; balance: number } | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let labelIndex = lines.findIndex((line) => line.includes("活存總額"));
  if (labelIndex === -1) {
    labelIndex = lines.findIndex(
      (line) =>
        line === "活存" ||
        line.includes("活期儲蓄") ||
        line.includes("存款總額"),
    );
  }
  if (labelIndex === -1) return undefined;

  let balance: number | undefined;
  const searchEnd = Math.min(labelIndex + 5, lines.length);
  for (let i = labelIndex; i < searchEnd; i += 1) {
    const line = lines[i] ?? "";
    const amountMatch =
      line.match(/\$\s*(-?[\d,]+)/) ??
      (i > labelIndex ? line.match(/^(-?[\d,]+)$/) : null);
    if (amountMatch?.[1] !== undefined) {
      balance = parseAmount(amountMatch[1]);
      break;
    }
  }

  const accountNo = findDepositAccountNo(lines, labelIndex);
  if (!accountNo || balance === undefined) return undefined;
  return { accountNo, balance };
}

const ACCOUNT_SEARCH_RADIUS = 8;
/** 交易明細、轉帳等區塊的起點：帳號搜尋碰到就停，不跨進去找。 */
const SECTION_BOUNDARY = /明細|交易|轉入|轉出|受款|收款|他行|跨行|約定/;

function mentionsOtherBank(line: string): boolean {
  if (line.includes("樂天")) return false;
  return (
    /銀行|商銀|郵局|郵政|合作社|農會|漁會/.test(line) ||
    new RegExp(`\\((?!${RAKUTEN_BANK_CODE}\\))\\d{3}\\)`).test(line)
  );
}

/**
 * 只在「活存總額」等標籤附近找帳號（白名單思維）：由標籤往前、往後各掃
 * 描最多 8 行，碰到交易明細／轉帳區塊即停止；本行或上一行提到他行名稱
 * 或代碼的號碼一律略過。找不到就不猜，不再全文搜尋任意長數字，避免抓到
 * 轉入的他行對手帳號。
 */
function findDepositAccountNo(
  lines: string[],
  labelIndex: number,
): string | undefined {
  const found: Array<{ distance: number; accountNo: string }> = [];
  for (const step of [-1, 1]) {
    for (
      let distance = step === -1 ? 0 : 1;
      distance <= ACCOUNT_SEARCH_RADIUS;
      distance += 1
    ) {
      const index = labelIndex + step * distance;
      const line = lines[index];
      if (line === undefined) break;
      if (distance > 0 && SECTION_BOUNDARY.test(line)) break;
      if (
        mentionsOtherBank(line) ||
        mentionsOtherBank(lines[index - 1] ?? "")
      ) {
        continue;
      }
      const match = line.match(/(?<!\d)(\d{10,16})(?!\d)/);
      if (match?.[1]) {
        found.push({ distance, accountNo: match[1] });
        break;
      }
    }
  }
  found.sort((a, b) => a.distance - b.distance);
  return found[0]?.accountNo;
}

function parseAmount(value: string): number {
  if (!value) return 0;
  const cleaned = value.replace(/[$, ]/g, "").trim();
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : 0;
}
