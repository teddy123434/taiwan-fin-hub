const MEGABANK_EGRESS_HOST = "mobile.megabank.com.tw";
const MEGABANK_EGRESS_NAME = "megabank";

// 銀行依本次登入 IP 是否與上一筆不同來決定異地簡訊。
// 固定名稱的物件只在首次建立時採用 locationHint，之後留在同一機房；
// 手動同步與 Queue 排程都從那裡連線。
const MEGABANK_EGRESS_LOCATION = "apac" as const;

export function isMegabankEgressUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === MEGABANK_EGRESS_HOST;
  } catch {
    return false;
  }
}

export async function proxyMegabankEgress(
  request: Request,
  outbound: (request: Request) => Promise<Response> = fetch,
): Promise<Response> {
  if (request.method !== "POST" || !isMegabankEgressUrl(request.url)) {
    return new Response(null, { status: 403 });
  }
  return outbound(request);
}

export function createMegabankEgressFetcher(
  namespace: DurableObjectNamespace,
): typeof fetch {
  const stub = namespace.getByName(MEGABANK_EGRESS_NAME, {
    locationHint: MEGABANK_EGRESS_LOCATION,
  });
  return (input, init) => stub.fetch(input, init);
}
