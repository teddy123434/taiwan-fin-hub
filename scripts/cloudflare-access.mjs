import { createPublicKey, verify } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const accessSecretNames = ["TEAM_DOMAIN", "POLICY_AUD"];
const manualAccessNames = [...accessSecretNames, "POLICY_AUDS"];
const setupHelp =
  "Enable Protect with Cloudflare Access and choose All traffic in the Cloudflare GUI. See docs/005-deployment.md.";

function enabled(value) {
  return /^(true|1|yes|on)$/i.test(String(value ?? "").trim());
}

export function needsAccessSetup({
  environment,
  config = {},
  existingSecrets,
  suppliedSecrets = {},
}) {
  if (
    environment.WORKERS_CI !== "1" ||
    environment.ACCESS_AUTO_SETUP === "false" ||
    enabled(
      suppliedSecrets.DEMO_MODE ??
        config.vars?.DEMO_MODE ??
        environment.DEMO_MODE,
    )
  ) {
    return false;
  }

  // Explicit credentials belong to the user's manually configured application.
  // A supplied null deletes a secret, so do not count its old name as configured.
  const configured = (name) => {
    if (Object.hasOwn(suppliedSecrets, name)) {
      return Boolean(suppliedSecrets[name]?.trim());
    }
    return Boolean(config.vars?.[name]) || existingSecrets?.has(name);
  };
  const hasCredentials =
    configured("TEAM_DOMAIN") &&
    (configured("POLICY_AUD") || configured("POLICY_AUDS"));
  if (hasCredentials && environment.ACCESS_AUTO_SETUP !== "true") {
    return false;
  }
  if (
    manualAccessNames.some(
      (name) =>
        Object.hasOwn(suppliedSecrets, name) ||
        Object.hasOwn(config.vars ?? {}, name),
    )
  ) {
    if (!hasCredentials) {
      throw new Error(
        "Manual Access credentials are incomplete. Provide TEAM_DOMAIN and POLICY_AUD (or POLICY_AUDS), or remove them from Wrangler vars and the supplied secrets file to use automatic setup.",
      );
    }
    return false;
  }
  return true;
}

export function createCloudflareClient(apiToken, fetchApi = fetch) {
  if (!apiToken) {
    throw new Error(
      `Access setup requires the Workers Builds CLOUDFLARE_API_TOKEN. ${setupHelp}`,
    );
  }

  async function request(method, path) {
    const response = await fetchApi(
      `https://api.cloudflare.com/client/v4${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
      },
    );
    const data = await response.json();
    if (!response.ok || data.success !== true) {
      // Report codes rather than response bodies, which may contain credentials.
      const codes = (data.errors ?? []).map((error) => error.code).join(", ");
      throw new Error(
        `Cloudflare Access setup failed: ${method} ${path.split("?")[0]} (HTTP ${response.status}${codes ? `, codes ${codes}` : ""}). ${setupHelp}`,
      );
    }
    return data;
  }

  return { request };
}

export async function discoverAccessSecrets(workerUrl, fetchPublic = fetch) {
  const url = new URL(workerUrl);
  let metadata;
  // Access configuration can take a few seconds to reach the edge after deploy.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetchPublic(url.href, {
      method: "HEAD",
      redirect: "manual",
      headers: { "cf-access-metadata-request": "true" },
      signal: AbortSignal.timeout(10000),
    });
    metadata = response.headers.get("cf-access-metadata");
    if (metadata) break;
    if (attempt < 4) await delay(1000);
  }
  if (!metadata) {
    throw new Error(
      "Cloudflare Access metadata was not found. Enable Protect with Cloudflare Access, choose All traffic, then retry the build. See docs/005-deployment.md.",
    );
  }

  // Match cloudflared's GetAppInfo: verify signed metadata, never trust the
  // login redirect's query parameters as application identity.
  // https://github.com/cloudflare/cloudflared/blob/master/token/token.go
  try {
    const parts = metadata.split(".");
    if (parts.length !== 3 || parts.some((part) => !part)) throw new Error();
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = JSON.parse(
      Buffer.from(encodedHeader, "base64url").toString(),
    );
    const claims = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString(),
    );
    if (
      header.alg !== "RS256" ||
      typeof header.kid !== "string" ||
      typeof claims.auth_domain !== "string" ||
      !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(claims.auth_domain)
    ) {
      throw new Error();
    }
    const teamDomain = `https://${claims.auth_domain}`;
    const response = await fetchPublic(`${teamDomain}/cdn-cgi/access/certs`, {
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error();
    const { keys } = await response.json();
    const key = keys.find(
      (item) => item.kid === header.kid && item.kty === "RSA",
    );
    if (
      !key ||
      !verify(
        "RSA-SHA256",
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        createPublicKey({ key, format: "jwk" }),
        Buffer.from(encodedSignature, "base64url"),
      )
    ) {
      throw new Error();
    }
    const now = Date.now() / 1000;
    if (
      claims.type !== "match" ||
      typeof claims.hostname !== "string" ||
      claims.hostname.toLowerCase() !== url.hostname ||
      typeof claims.aud !== "string" ||
      !claims.aud.trim() ||
      !Number.isInteger(claims.iat) ||
      claims.iat <= 0 ||
      claims.iat < now - 86400 ||
      claims.iat > now + 300
    ) {
      throw new Error();
    }
    return { TEAM_DOMAIN: teamDomain, POLICY_AUD: claims.aud };
  } catch {
    throw new Error(
      "Cloudflare Access metadata could not be verified. Configure TEAM_DOMAIN and POLICY_AUD manually if discovery is unavailable. See docs/005-deployment.md.",
    );
  }
}

export async function prepareAccessSetup({
  environment,
  config,
  existingSecrets,
  suppliedSecrets,
  fetchApi,
  fetchPublic,
}) {
  if (
    !needsAccessSetup({ environment, config, existingSecrets, suppliedSecrets })
  ) {
    return null;
  }

  const accountId = environment.CLOUDFLARE_ACCOUNT_ID ?? config.account_id;
  // Wrangler gives the GUI-selected name precedence over config and --name.
  const workerName = environment.WRANGLER_CI_OVERRIDE_NAME ?? config.name;
  if (!accountId || !workerName) {
    throw new Error(
      "Access setup requires the deployment's CLOUDFLARE_ACCOUNT_ID (or Wrangler account_id) and Worker name.",
    );
  }
  const client = createCloudflareClient(
    environment.CLOUDFLARE_API_TOKEN,
    fetchApi,
  );
  const accountPath = `/accounts/${encodeURIComponent(accountId)}`;
  return {
    async complete() {
      const { result } = await client.request(
        "GET",
        `${accountPath}/workers/subdomain`,
      );
      if (
        !/^[a-z0-9-]+$/i.test(result?.subdomain ?? "") ||
        !/^[a-z0-9-]+$/i.test(workerName)
      ) {
        throw new Error("Unable to find the deployed workers.dev hostname.");
      }
      const workerUrl = `https://${workerName}.${result.subdomain}.workers.dev/`;
      const secrets = await discoverAccessSecrets(workerUrl, fetchPublic);
      console.log(
        "[deploy] Verified the Cloudflare GUI's Worker Access configuration.",
      );
      return secrets;
    },
  };
}
