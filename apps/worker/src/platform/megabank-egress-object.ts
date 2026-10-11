import { DurableObject } from "cloudflare:workers";
import { proxyMegabankEgress } from "./megabank-egress";

export class MegabankEgress extends DurableObject {
  fetch(request: Request) {
    return proxyMegabankEgress(request);
  }
}
