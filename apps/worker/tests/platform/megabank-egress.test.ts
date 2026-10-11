import { describe, expect, it, vi } from "vitest";
import {
  createMegabankEgressFetcher,
  proxyMegabankEgress,
} from "../../src/platform/megabank-egress";

const bankUrl = "https://mobile.megabank.com.tw/ixtein/main/init";

describe("兆豐固定出口", () => {
  it("只轉送兆豐 App API 的 POST，其他目的地不發出連線", async () => {
    const outbound = vi.fn(async (_request: Request) => new Response("ok"));
    const request = new Request(bankUrl, { method: "POST", body: "{}" });

    const allowed = await proxyMegabankEgress(request, outbound);
    const blocked = await proxyMegabankEgress(
      new Request("https://example.com/ixtein", { method: "POST", body: "{}" }),
      outbound,
    );
    const wrongMethod = await proxyMegabankEgress(
      new Request(bankUrl, { method: "GET" }),
      outbound,
    );

    expect(allowed.status).toBe(200);
    expect(blocked.status).toBe(403);
    expect(wrongMethod.status).toBe(403);
    expect(outbound).toHaveBeenCalledTimes(1);
    expect(outbound).toHaveBeenCalledWith(request);
  });

  it("每次都指向同一個 apac 物件", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const getByName = vi.fn(() => ({ fetch }));
    const fetcher = createMegabankEgressFetcher({
      getByName,
    } as unknown as DurableObjectNamespace);
    const init = { method: "POST", body: "{}" };

    await fetcher(bankUrl, init);

    expect(getByName).toHaveBeenCalledWith("megabank", {
      locationHint: "apac",
    });
    expect(fetch).toHaveBeenCalledWith(bankUrl, init);
  });
});
