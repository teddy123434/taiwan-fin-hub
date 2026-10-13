import { describe, expect, it, vi } from "vitest";
import {
  createSinopacConnector,
  SINOPAC_SESSION_PROTOCOL,
  SinopacVerificationRequiredError,
} from "../../../src/sources/sinopac/connector";
import { parseSinopacConfig } from "../../../src/sources/sinopac/protocol";

describe("永豐 connector 安全錯誤處理", () => {
  it("HTTP 200 登入頁不進入帳戶 parser，也不記錄 response、session 或憑證", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const responseBody =
      "<html><body>m_login PRIVATE_HTML_SENTINEL 777777777</body></html>";
    const fetchImpl = vi.fn(
      async () =>
        new Response(responseBody, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
    const config = parseSinopacConfig({
      userId: "PRIVATE_USER_ID_SENTINEL",
      account: "PRIVATE_ACCOUNT_SENTINEL",
      password: "PRIVATE_PASSWORD_SENTINEL",
      sessionCookies: JSON.stringify([
        {
          name: "SESSION",
          value: "PRIVATE_COOKIE_SENTINEL",
          domain: "m.sinopac.com",
          expires: -1,
        },
      ]),
      protocol: SINOPAC_SESSION_PROTOCOL,
    });

    try {
      const connector = createSinopacConnector(undefined, fetchImpl);
      await expect(connector.sync(config)).rejects.toBeInstanceOf(
        SinopacVerificationRequiredError,
      );
      expect(info).not.toHaveBeenCalled();
      expect(warning).not.toHaveBeenCalled();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      info.mockRestore();
      warning.mockRestore();
    }
  });

  it("在貸款 fetch 階段重新拋出驗證錯誤，不把已取回資料當成成功同步", async () => {
    const paths: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === "/ws/bank/bankbal/ws_bankbal.ashx") {
        return new Response(
          JSON.stringify([{ Header: "SUCCESS", RecordCount: 0, SubInfo: [] }]),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (path === "/ws/card/cardqry/ws_cardsum.ashx") {
        return new Response(
          JSON.stringify([
            {
              Header: "SUCCESS",
              Message: "尚未持有本行信用卡",
              SubInfo: [],
            },
          ]),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (path === "/ws/bank/loan/ws_loanaccount.ashx") {
        return new Response("<html><body>m_login</body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      throw new Error("unexpected synthetic endpoint");
    });
    const config = parseSinopacConfig({
      userId: "SYNTHETIC_USER_ID",
      account: "SYNTHETIC_ACCOUNT",
      password: "SYNTHETIC_PASSWORD",
      sessionCookies: JSON.stringify([
        {
          name: "SESSION",
          value: "SYNTHETIC_COOKIE",
          domain: "m.sinopac.com",
          expires: -1,
        },
      ]),
      protocol: SINOPAC_SESSION_PROTOCOL,
    });

    await expect(
      createSinopacConnector(undefined, fetchImpl).sync(config),
    ).rejects.toBeInstanceOf(SinopacVerificationRequiredError);
    expect(paths).toEqual([
      "/ws/bank/bankbal/ws_bankbal.ashx",
      "/ws/card/cardqry/ws_cardsum.ashx",
      "/ws/bank/loan/ws_loanaccount.ashx",
    ]);
  });
});
