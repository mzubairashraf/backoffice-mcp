// End-to-end smoke test against a running server (default: `npm run dev`).
// It does what an MCP app does: registers itself, goes through the consent
// page, exchanges the code for a token, then lists and calls tools.
//
//   npm run dev          # in one terminal
//   npm run smoke        # in another
//
// Works only against AUTH_MODE=demo, where sign-in is a form field.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const origin = process.argv[2] ?? "http://localhost:8787";
const redirect = "http://localhost:9999/callback";
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

const registered = await (
  await fetch(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Smoke Test", redirect_uris: [redirect], token_endpoint_auth_method: "none" })
  })
).json();

const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
const authorize = new URL(`${origin}/authorize`);
authorize.search = new URLSearchParams({
  response_type: "code",
  client_id: registered.client_id,
  redirect_uri: redirect,
  code_challenge: challenge,
  code_challenge_method: "S256",
  state: "smoke",
  resource: `${origin}/mcp`
}).toString();

const page = await fetch(authorize);
const handle = /name="handle" value="([^"]+)"/.exec(await page.text())?.[1];
const cookie = page.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const form = new URLSearchParams({ handle, decision: "approve", demo_user: `smoke-${Date.now()}` });
form.append("scope", "backoffice:read");
form.append("scope", "backoffice:write");
const approved = await fetch(`${origin}/authorize`, { method: "POST", redirect: "manual", headers: { Cookie: cookie }, body: form });
const code = new URL(approved.headers.get("location")).searchParams.get("code");

const token = await (
  await fetch(`${origin}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: registered.client_id,
      redirect_uri: redirect,
      code_verifier: verifier,
      resource: `${origin}/mcp`
    })
  })
).json();
console.log("token scope:", token.scope, "| expires in:", token.expires_in);

const client = new Client(
  { name: "smoke-test", version: "0.0.0" },
  { capabilities: { elicitation: {} }, versionNegotiation: { mode: { pin: "2026-07-28" } } }
);
client.setRequestHandler("elicitation/create", async (request) => {
  console.log("server asked the user:", request.params.message);
  return { action: "accept", content: { confirm: true } };
});
await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { authProvider: { token: async () => token.access_token } }));

const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  return JSON.parse(result.content[0].text);
};

const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`, tools.map((t) => t.name).join(", "));

console.log("get_receivables_summary:", JSON.stringify(await call("get_receivables_summary")));

const overdue = await call("list_invoices", { overdue_only: true });
const invoice = overdue.items[0];
console.log("overdue:", overdue.items.map((i) => `${i.number} ${i.customer_name} due ${i.amount_due}`).join(" | "));

const key = crypto.randomUUID();
const paid = await call("record_payment", { invoice_id: invoice.id, amount: 25_000, method: "bank_transfer", idempotency_key: key });
console.log("record_payment:", JSON.stringify({ payment: paid.payment.id, replayed: paid.replayed, amount_paid: paid.invoice.amount_paid, amount_due: paid.invoice.amount_due }));

const retry = await call("record_payment", { invoice_id: invoice.id, amount: 25_000, method: "bank_transfer", idempotency_key: key });
console.log("same request again:", JSON.stringify({ payment: retry.payment.id, replayed: retry.replayed, amount_paid: retry.invoice.amount_paid }));

console.log("get_invoice (missing):", JSON.stringify(await call("get_invoice", { invoice_id: "inv_doesnotexist" })));
console.log("audit:", (await call("list_audit_log", { limit: 5 })).entries.map((e) => `${e.tool}:${e.outcome}`).join(", "));
await client.close();
