/** 只接受明確的無卡敘述，不將查無帳單、申請說明或其他錯誤當成無卡。 */
export function isNoCreditCardMessage(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const message = value.replace(/\s+/g, "").replace(/^\d{4}[:：]/, "");
  return /^(?:您)?(?:目前)?(?:(?:尚未|未|沒有|無)(?:持有|申辦|申請)?(?:本行)?信用卡|沒有(?:本行)?有效卡|非(?:本行)?(?:信用卡)?(?:持卡人|卡友)|非(?:本行)?信用卡客戶)(?=[，,。.!！；;]|$)/.test(
    message,
  );
}
