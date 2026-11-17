import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { SELF } from "cloudflare:test";

export const ORIGIN = "http://localhost:8787";
export const MCP_URL = `${ORIGIN}/mcp`;
const REDIRECT = "http://localhost:9999/callback";

export const ALL_SCOPES = ["backoffice:read", "backoffice:write", "backoffice:unattended"];
export const READ_WRITE = ["backoffice:read", "backoffice:write"];
export const READ_ONLY = ["backoffice:read"];

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function registerClient(name = "Test Client"): Promise<string> {
  const response = await SELF.fetch(`${ORIGIN}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" })
  });
  if (!response.ok) throw new Error(`register failed: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { client_id: string }).client_id;
}

/** Opens the consent page the way a browser would and returns what is needed to submit it. */
export async function openConsent(clientId: string) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const url = new URL(`${ORIGIN}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    resource: MCP_URL
  }).toString();
  const page = await SELF.fetch(url, { redirect: "manual" });
  const html = await page.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const cookie = (page.headers.getSetCookie?.() ?? []).map((c: string) => c.split(";")[0]).join("; ");
  return { status: page.status, html, handle, cookie, verifier, headers: page.headers };
}

export async function submitConsent(opts: { handle: string; cookie?: string; user: string; scopes: string[]; decision?: string }) {
  const form = new URLSearchParams({ handle: opts.handle, decision: opts.decision ?? "approve", demo_user: opts.user });
  for (const scope of opts.scopes) form.append("scope", scope);
  return SELF.fetch(`${ORIGIN}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(opts.cookie ? { Cookie: opts.cookie } : {}) },
    body: form
  });
}

/** Runs the whole OAuth 2.1 flow (register, consent, code, token) and returns an access token. */
export async function signIn(user: string, scopes: string[] = READ_WRITE): Promise<{ token: string; clientId: string; scope: string }> {
  const clientId = await registerClient();
  const consent = await openConsent(clientId);
  const approved = await submitConsent({ handle: consent.handle, cookie: consent.cookie, user, scopes });
  const location = approved.headers.get("Location");
  if (approved.status !== 302 || !location) throw new Error(`consent failed: ${approved.status} ${await approved.text()}`);
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error(`no code in redirect: ${location}`);

  const tokenResponse = await SELF.fetch(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: consent.verifier,
      resource: MCP_URL
    })
  });
  const body = (await tokenResponse.json()) as { access_token?: string; scope?: string; error?: string };
  if (!body.access_token) throw new Error(`token exchange failed: ${JSON.stringify(body)}`);
  return { token: body.access_token, clientId, scope: body.scope ?? "" };
}

export interface Session {
  client: Client;
  /** Confirmation prompts the server asked the user, in order. */
  prompts: string[];
  /** Every HTTP request the client sent to the MCP endpoint, for replay tests. */
  sent: { headers: Record<string, string>; body: string }[];
  call: (name: string, args?: Record<string, unknown>) => Promise<{ ok: true; data: any } | { ok: false; error: { code: string; message: string; field?: string } }>;
}

/**
 * Connects a real MCP client to the Worker with the given token.
 * `confirm` plays the user: "accept", "decline", or "none" for a client that
 * cannot show confirmation prompts at all.
 */
export async function connect(
  token: string,
  confirm: "accept" | "decline" | "untick" | "none" = "accept",
  era: "modern" | "legacy" = "modern"
): Promise<Session> {
  const prompts: string[] = [];
  const sent: Session["sent"] = [];
  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    {
      capabilities: confirm === "none" ? {} : { elicitation: {} },
      // "modern" speaks MCP 2026-07-28; "legacy" does the 2025-era handshake older apps still use.
      ...(era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {})
    }
  );
  if (confirm !== "none") {
    client.setRequestHandler("elicitation/create", async (request) => {
      prompts.push(String((request.params as { message?: string }).message));
      if (confirm === "decline") return { action: "decline" as const };
      return { action: "accept" as const, content: { confirm: confirm === "accept" } };
    });
  }
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    authProvider: { token: async () => token },
    // SELF.fetch does not add a Host header, and the MCP handler validates it.
    fetch: (input, init) => {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      headers.set("Host", new URL(ORIGIN).host);
      const body = (init as RequestInit | undefined)?.body;
      if (typeof body === "string") sent.push({ headers: Object.fromEntries(headers), body });
      return SELF.fetch(input as RequestInfo, { ...(init as RequestInit), headers });
    }
  });
  await client.connect(transport);

  return {
    client,
    prompts,
    sent,
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as { type: string; text?: string }[])[0]?.text ?? "";
      if (result.isError) {
        try {
          return { ok: false, error: JSON.parse(text).error };
        } catch {
          return { ok: false, error: { code: "protocol_error", message: text } };
        }
      }
      return { ok: true, data: JSON.parse(text) };
    }
  };
}

/** Signs in and connects in one step. */
export async function session(
  user: string,
  scopes: string[] = READ_WRITE,
  confirm: "accept" | "decline" | "untick" | "none" = "accept",
  era: "modern" | "legacy" = "modern"
) {
  const { token } = await signIn(user, scopes);
  return connect(token, confirm, era);
}

export function expectOk<T extends { ok: boolean }>(result: T): asserts result is Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result)}`);
}

export function expectError<T extends { ok: boolean }>(result: T): asserts result is Extract<T, { ok: false }> {
  if (result.ok) throw new Error(`expected an error, got ${JSON.stringify(result)}`);
}

/** Sends a raw, hand-built request to the MCP endpoint, as a misbehaving client could. */
export async function rawMcp(headers: Record<string, string>, body: string): Promise<{ status: number; text: string }> {
  const response = await SELF.fetch(MCP_URL, { method: "POST", headers, body });
  return { status: response.status, text: await response.text() };
}
