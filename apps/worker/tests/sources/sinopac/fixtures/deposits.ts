/** Synthetic values using the authenticated mobile-bank response structure. */
export const sinopacDepositAccounts = [
  {
    Header: "SUCCESS",
    Message: "",
    SubInfo: [
      {
        AcctValue: "0000000012345",
        AcctValueFormat: "000-000-0012345",
        AcctText: "活期儲蓄存款",
        Curr: "TWD",
        AvailBalInt: "12,000",
        MaxAvail: "11,900",
        FixBalance: "綜存定存：100,000 元",
      },
      {
        AcctValue: "0000000012345",
        AcctValueFormat: "000-000-0012345",
        AcctText: "外幣組合存款",
        Curr: "USD",
        AvailBalInt: "0",
        MaxAvail: "0",
        FixBalance: "綜存定存：0 元",
      },
    ],
  },
];

export const sinopacDepositTransactions = [
  {
    Header: "SUCCESS",
    Message: "",
    RecordCount: "1",
    SubInfo: [
      {
        DataText1: "2026/10/02<br />19:06",
        DataText2: "2026/10/05",
        DataText3: "ATM現金",
        DataText4: '<font color="#ff6000">-1,000</font>',
        DataText5: "12,000",
        DataText6: "",
        DataText8: "跨行提款<br>0000000098765",
      },
      {
        DataText1: "2026/10/01",
        DataText2: "2026/10/01",
        DataText3: "跨行轉入",
        DataText4: '<font color="#009a12">+600</font>',
        DataText5: "13,000",
        DataText6: "",
        DataText8: "0000000076543<br>測試匯款",
      },
    ],
  },
];

export const sinopacDepositNoTransactions = [
  { Header: "FAIL", Message: "查無資料", RecordCount: null, SubInfo: [] },
];
