import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCtbcConnector,
  type CtbcFetch,
} from "../../../src/sources/ctbc/mobile-api";

const credentials = {
  userId: "synthetic-id",
  account: "synthetic-user",
  password: "synthetic-password",
};
const privateValue = "private-bank-payload";
const privateFields = {
  custId: credentials.userId,
  accountId: "1234567890123456",
  otp: "654321",
  unknownField: privateValue,
};

function bankApi(loginResponses: Response[]) {
  const responses = [
    Response.json({ access_token: "private-oauth-token" }),
    Response.json({ statusCode: "0000" }),
    Response.json({
      success: true,
      token: "private-transaction-token",
      rsData: { seed: "private-seed" },
    }),
    ...loginResponses,
  ];
  const fetcher: CtbcFetch = vi.fn(async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected request after login rejection");
    return response;
  });
  return fetcher;
}

function loginResponse(data: Record<string, unknown>, status = 200) {
  return Response.json(
    {
      sys: "SVC",
      code: "0131",
      message: privateValue,
      token: "private-response-token",
      rsData: { ...privateFields, seed: "private-response-seed" },
      ...data,
    },
    {
      status,
      headers: {
        "x-auth-token": "private-auth-token",
        "set-cookie": "private-session-cookie",
      },
    },
  );
}

function expectPrivateValuesAbsent(logged: string) {
  for (const value of [
    ...Object.values(credentials),
    ...Object.values(privateFields),
    "private-oauth-token",
    "private-transaction-token",
    "private-seed",
    "private-response-token",
    "private-response-seed",
    "private-auth-token",
    "private-session-cookie",
  ]) {
    expect(logged).not.toContain(value);
  }
}

afterEach(() => vi.restoreAllMocks());

describe("中信登入診斷的憑證保護", () => {
  it.each([
    {
      label: "缺少描述與狀態碼",
      data: {},
      descCategory: "missing",
      statusCodeType: "missing",
    },
    {
      label: "更新提示與 null 狀態碼",
      data: {
        desc: `<p>請更新至最新版本使用 ${privateValue}</p>`,
        statusCode: null,
      },
      descCategory: "app_update_prompt",
      statusCodeType: "null",
    },
    {
      label: "其他描述與空字串狀態碼",
      data: { desc: privateValue, statusCode: "" },
      descCategory: "other",
      statusCodeType: "string",
    },
  ])("$label只記錄分類，不外洩銀行回應", async ({ data, ...expected }) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      createCtbcConnector(bankApi([loginResponse(data)])).sync(credentials),
    ).rejects.toMatchObject({
      name: "CtbcConnectionError",
      message: "中國信託資料同步暫時無法完成。",
    });

    const logged = warn.mock.calls.flat().join("\n");
    expect(JSON.parse(logged)).toEqual({
      event: "ctbc_mobile_resource_failed",
      resource: "/twrbm-general/ot001/010",
      system: "SVC",
      code: "0131",
      statusCode: "",
      httpStatus: 200,
      loginAttempt: 1,
      confirmationType: "initial",
      appVer: expect.any(String),
      webVer: expect.any(String),
      statusCodeType: expected.statusCodeType,
      descCategory: expected.descCategory,
      hasRsData: true,
      verificationFlags: {
        deviceConfirmation: false,
        duplicateLoginConfirmation: false,
        bindDevice: false,
        otp: false,
        twoStage: false,
        verificationRequired: false,
      },
    });
    expect(logged).not.toContain("<p>");
    expect(logged).not.toContain("更新至最新版本");
    expectPrivateValuesAbsent(logged);
  });

  it.each([
    {
      confirmationType: "device",
      timestampField: "deviceBindBlackListCheckTimestamp",
      flag: "deviceConfirmation",
    },
    {
      confirmationType: "duplicate",
      timestampField: "dupLoginCheckTimestamp",
      flag: "duplicateLoginConfirmation",
    },
  ])(
    "$confirmationType確認後的失敗保留次數及旗標，不外洩時間戳",
    async ({ confirmationType, timestampField, flag }) => {
      const timestamp = "private-confirmation-timestamp";
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const fetcher = bankApi([
        loginResponse({
          code: "0000",
          rsData: { [timestampField]: timestamp },
        }),
        loginResponse(
          { rsData: { ...privateFields, [timestampField]: timestamp } },
          201,
        ),
      ]);

      await expect(
        createCtbcConnector(fetcher).sync(credentials),
      ).rejects.toMatchObject({ name: "CtbcConnectionError" });

      const logged = warn.mock.calls.flat().join("\n");
      expect(JSON.parse(logged)).toMatchObject({
        httpStatus: 201,
        loginAttempt: 2,
        confirmationType,
        verificationFlags: { [flag]: true },
      });
      expect(logged).not.toContain(timestamp);
      expectPrivateValuesAbsent(logged);
    },
  );

  it.each(["0000", "0131"])(
    "登入回應 %s 需要驗證時，只記錄固定的布林旗標",
    async (code) => {
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const fetcher = bankApi([
        loginResponse({
          code,
          rsData: {
            ...privateFields,
            needBindDevice: "Y",
            needOTP: true,
            needTwoStage: 1,
            [`needOTP_${privateValue}`]: true,
          },
        }),
      ]);

      await expect(
        createCtbcConnector(fetcher).sync(credentials),
      ).rejects.toMatchObject({ name: "CtbcVerificationRequiredError" });

      const logged = warn.mock.calls.flat().join("\n");
      expect(JSON.parse(logged)).toMatchObject({
        event:
          code === "0000"
            ? "ctbc_login_verification_required"
            : "ctbc_mobile_resource_failed",
        httpStatus: 200,
        loginAttempt: 1,
        confirmationType: "initial",
        verificationFlags: {
          deviceConfirmation: false,
          duplicateLoginConfirmation: false,
          bindDevice: true,
          otp: true,
          twoStage: true,
          verificationRequired: true,
        },
      });
      expectPrivateValuesAbsent(logged);
    },
  );
});
