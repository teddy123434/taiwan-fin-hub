import forge from "node-forge";
import { BANK_SYNC_MONTHS } from "../sync-window";

// Observed in the official web login bundle on 2026-09-27.
// This is an internal web API, not a published developer API.
const ORIGIN = "https://api.nextbank.com.tw";
const CAPTCHA_PATH = "/ap2/open/common/v1.0/Captcha";
const LOGIN_PATH = "/ap2/api/v1.1/membership/CaptchaLogin";
const MODULUS =
  "B65A34251E089C68D3A586D403D3A31362B8287AAB9C7BD8F90311185D823492D953EE917F261C148A5518F2745CA46148E481CE5718820A0BE208B8EE9D465628DC9F17893B315E986388507AA21B3A058CB6E7C5768746BE236D490BA76F29BF70D06A9B7FBFC8BF86FEC6D44BAA53C44CDACD5D8D3D2820BC776B3D31637094227D8B029941CF5BF7A20D86A7E5209961C111F92F3E10700429F386637B8A9A667348A2C7AC98BF60078101ACA1D4D772457E49411B4F7D94AC8EDA62EED196C4A943635E4227B5B86B5357D9939DDD66652DF99D6B1D82696708E41B8B9829E3D5558FA3F961674BA28D94508CBC7F87E4820E293790AFA0D4B2EEAC386B";
const CHALLENGE_TTL_MS = 2 * 60_000;

export type NextbankErrorKind =
  | "credentials"
  | "captcha"
  | "session_conflict"
  | "session_expired"
  | "account_unavailable"
  | "rate_limit"
  | "transport"
  | "protocol";

export class NextbankApiError extends Error {
  constructor(public readonly kind: NextbankErrorKind) {
    super(`將來銀行 API：${kind}`);
    this.name = "NextbankApiError";
  }
}

export type NextbankCaptcha = {
  uuid: string;
  imageBase64: string;
  expiresAt: number;
};

type JsonRecord = Record<string, unknown>;
function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NextbankApiError("protocol");
  }
  return value as JsonRecord;
}

function nonempty(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new NextbankApiError("protocol");
  }
  return value;
}

function errorKind(code: unknown): NextbankErrorKind {
  if (code === "ERROR_ACSTKN_ERROR") return "session_expired";
  if (code === "CAPTCHA_ERROR" || code === "CAPTCHA_EXPIRED") return "captcha";
  if (code === "OTHER_DEVICE_LOGIN" || code === "ABNORMAL_LOGOUT") {
    return "session_conflict";
  }
  if (
    code === "LOGIN_ERROR" ||
    (typeof code === "string" &&
      /^CONTINUOUSLY_LOGIN_ERROR_[1-5]_TIMES$/.test(code))
  ) {
    return "credentials";
  }
  if (
    code === "MEMBER_LOCKED" ||
    code === "ACCOUNT_CLOSED" ||
    code === "ACCOUNT_EMERGENTLY_CLOSED" ||
    code === "ACCOUNT_OPENING_IS_REVIEWING" ||
    code === "ACCOUNT_OPENING_IS_DECLINED"
  ) {
    return "account_unavailable";
  }
  return "protocol";
}

/** Implements observed web authentication and read-only query requests.
 * Deposit and pocket queries are integrated with the Worker sync service.
 * The caller must keep CAPTCHA/session state out of logs and plaintext storage.
 */
export class NextbankApiClient {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private pending?: Pick<NextbankCaptcha, "uuid" | "expiresAt">;

  constructor(options: { fetcher?: typeof fetch; now?: () => number } = {}) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
  }

  /** Restore only from the caller's encrypted, version-guarded configuration.
   * Image bytes and the answer are not needed to restore a pending challenge.
   */
  restoreCaptcha(challenge: Pick<NextbankCaptcha, "uuid" | "expiresAt">): void {
    this.pending = undefined;
    const now = this.now();
    if (
      typeof challenge.uuid !== "string" ||
      !challenge.uuid.trim() ||
      !Number.isSafeInteger(challenge.expiresAt) ||
      challenge.expiresAt <= now ||
      challenge.expiresAt > now + CHALLENGE_TTL_MS
    )
      throw new NextbankApiError("captcha");
    this.pending = { uuid: challenge.uuid, expiresAt: challenge.expiresAt };
  }

  private async post(
    path: string,
    body: JsonRecord,
    accessToken?: string,
    allowEmptyData = false,
  ): Promise<JsonRecord> {
    let response: Response;
    try {
      response = await this.fetcher(`${ORIGIN}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-NCB-Channel": "WEB",
          Channel: "WEB",
          ...(accessToken ? { Acstkn: accessToken } : {}),
        },
        body: JSON.stringify(body),
        // Workers supports manual redirects; non-2xx responses are rejected below.
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // Never propagate request bodies, bank error messages, or tokens.
      throw new NextbankApiError("transport");
    }
    if (response.status === 429) throw new NextbankApiError("rate_limit");
    if (!response.ok) throw new NextbankApiError("transport");
    let envelope: JsonRecord;
    try {
      envelope = record(await response.json());
    } catch {
      throw new NextbankApiError("protocol");
    }
    if (envelope.success === false) {
      throw new NextbankApiError(errorKind(record(envelope.error).errorCode));
    }
    if (envelope.success !== true) throw new NextbankApiError("protocol");
    return allowEmptyData && envelope.data == null ? {} : record(envelope.data);
  }

  async logout(accessToken: string): Promise<void> {
    await this.post(
      "/ap2/api/v1.0/membership/Logout",
      {},
      nonempty(accessToken),
      true,
    );
  }

  async getAccountOverview(accessToken: string): Promise<JsonRecord> {
    return this.post(
      "/ap2/api/v2.1/membership/AllInOne",
      {},
      nonempty(accessToken),
    );
  }

  async getPockets(accessToken: string): Promise<JsonRecord> {
    return this.post(
      "/ap1/api/v3.0/AppMainPage/PocketInfo",
      {},
      nonempty(accessToken),
    );
  }

  async getTermDeposit(
    accessToken: string,
    arrngId: string,
  ): Promise<JsonRecord> {
    return this.post(
      "/ap1/api/v2.3/termdeposit/GetTermDepositDetail",
      { arrngId: nonempty(arrngId) },
      nonempty(accessToken),
    );
  }

  async getMainAccountTransactions(
    accessToken: string,
    startDateTime: number,
    endDateTime: number,
  ): Promise<JsonRecord> {
    if (
      !Number.isSafeInteger(startDateTime) ||
      !Number.isSafeInteger(endDateTime) ||
      startDateTime < 0 ||
      endDateTime < startDateTime
    )
      throw new NextbankApiError("protocol");
    return this.post(
      "/ap1/api/v3.0/AppMainPage/CurrentDepositDetail",
      { startDateTime, endDateTime },
      nonempty(accessToken),
    );
  }

  async getPocketTransactions(
    accessToken: string,
    accNo: string,
    paging: { pageToken: string; startTradeID: string; pageSize: number } = {
      pageToken: "",
      startTradeID: "",
      pageSize: 10,
    },
  ): Promise<JsonRecord> {
    if (
      !Number.isInteger(paging.pageSize) ||
      paging.pageSize < 1 ||
      paging.pageSize > 10
    ) {
      throw new NextbankApiError("protocol");
    }
    return this.post(
      "/ap1/api/v1.0/demandDeposit/GetPocketTxDetail",
      { accNo: nonempty(accNo), paging },
      nonempty(accessToken),
    );
  }

  async prepareCaptcha(): Promise<NextbankCaptcha> {
    this.pending = undefined;
    const data = await this.post(CAPTCHA_PATH, { isAudio: false });
    const challenge = {
      uuid: nonempty(data.uuid),
      imageBase64: nonempty(data.captchaImage),
      expiresAt: this.now() + CHALLENGE_TTL_MS,
    };
    this.pending = { ...challenge };
    return challenge;
  }

  async login(credentials: {
    identity: string;
    userId: string;
    password: string;
    captchaResult: string;
  }): Promise<{ accessToken: string }> {
    const challenge = this.pending;
    // A submitted challenge is consumed even on failure. Never retry a password.
    this.pending = undefined;
    if (!challenge || this.now() >= challenge.expiresAt) {
      throw new NextbankApiError("captcha");
    }
    const { identity, userId, password, captchaResult } = credentials;
    if (
      !/^[A-Z][A-Z0-9]{9}$/i.test(identity) ||
      !/^[A-Za-z0-9@_.-]{6,16}$/.test(userId) ||
      !/^[\x21-\x7e]{8,16}$/.test(password) ||
      !/^[A-Za-z0-9]{1,5}$/.test(captchaResult)
    ) {
      throw new NextbankApiError("credentials");
    }
    const key = forge.pki.rsa.setPublicKey(
      new forge.jsbn.BigInteger(MODULUS, 16),
      new forge.jsbn.BigInteger("10001", 16),
    );
    const encrypted = forge.util
      .bytesToHex(key.encrypt(password, "RSAES-PKCS1-V1_5"))
      .toUpperCase();
    const data = await this.post(LOGIN_PATH, {
      identity,
      userId: btoa(userId),
      passwd: encrypted,
      captchaResult,
      captchaUuid: challenge.uuid,
      idgateId: "",
      isAbnormalLogout: false,
    });
    return { accessToken: nonempty(data.acstkn) };
  }
}

export type NextbankDepositPayloads = {
  pocketSummary: JsonRecord;
  overview: JsonRecord;
  mainTransactions: JsonRecord[];
  pockets: JsonRecord[];
  pocketTransactions: Array<{ accNo: string; pages: JsonRecord[] }>;
  termDeposits: Array<{ arrngId: string; detail: JsonRecord }>;
};

/** Gather a complete bounded read-only snapshot before any persistence.
 * Page tokens and raw account numbers stay inside this call's return value.
 * They must not be placed in the public sync cursor.
 */
export async function collectNextbankDepositPayloads(
  client: NextbankApiClient,
  accessToken: string,
  now = new Date(),
): Promise<NextbankDepositPayloads> {
  if (!Number.isFinite(now.getTime())) throw new NextbankApiError("protocol");
  const overview = await client.getAccountOverview(accessToken);
  const pocketResponse = await client.getPockets(accessToken);
  if (
    !Array.isArray(pocketResponse.pocketDetails) ||
    pocketResponse.pocketDetails.length > 100
  ) {
    throw new NextbankApiError("protocol");
  }
  const pockets = pocketResponse.pocketDetails.map(record);
  const mainTransactions: JsonRecord[] = [];
  const taiwanNow = new Date(now.getTime() + 8 * 3600_000);
  const year = taiwanNow.getUTCFullYear();
  const month = taiwanNow.getUTCMonth();
  for (let offset = 0; offset < BANK_SYNC_MONTHS; offset++) {
    const start = Date.UTC(year, month - offset, 1) - 8 * 3600_000;
    const end = Math.min(
      Date.UTC(year, month - offset + 1, 1) - 8 * 3600_000 - 1,
      now.getTime(),
    );
    const page = await client.getMainAccountTransactions(
      accessToken,
      start,
      end,
    );
    if (!Array.isArray(page.trades)) throw new NextbankApiError("protocol");
    mainTransactions.push(page);
  }
  const pocketTransactions: NextbankDepositPayloads["pocketTransactions"] = [];
  const termDeposits: NextbankDepositPayloads["termDeposits"] = [];
  for (const pocket of pockets) {
    if (pocket.depositType === "TERMDEPOSIT") {
      const arrngId = nonempty(pocket.arrngId);
      termDeposits.push({
        arrngId,
        detail: await client.getTermDeposit(accessToken, arrngId),
      });
      continue;
    }
    if (pocket.depositType !== "DEPOSIT")
      throw new NextbankApiError("protocol");
    const accNo = nonempty(pocket.accNo);
    const pages: JsonRecord[] = [];
    const seen = new Set<string>();
    let paging = { pageToken: "", startTradeID: "", pageSize: 10 };
    for (;;) {
      if (pages.length >= 1000) throw new NextbankApiError("protocol");
      const page = await client.getPocketTransactions(
        accessToken,
        accNo,
        paging,
      );
      if (!Array.isArray(page.trades)) throw new NextbankApiError("protocol");
      const info = record(page.pageInfo);
      if (typeof info.hasNext !== "boolean")
        throw new NextbankApiError("protocol");
      pages.push(page);
      if (!info.hasNext) break;
      if (page.trades.length === 0) throw new NextbankApiError("protocol");
      paging = {
        pageToken: nonempty(info.pageToken),
        startTradeID: nonempty(info.lastTradeID),
        pageSize: 10,
      };
      const key = JSON.stringify([paging.pageToken, paging.startTradeID]);
      if (seen.has(key)) throw new NextbankApiError("protocol");
      seen.add(key);
    }
    pocketTransactions.push({ accNo, pages });
  }
  return {
    overview,
    pocketSummary: {
      depositTotalAmount: pocketResponse.depositTotalAmount,
      termDepositTotalAmount: pocketResponse.termDepositTotalAmount,
    },
    mainTransactions,
    pockets,
    pocketTransactions,
    termDeposits,
  };
}
