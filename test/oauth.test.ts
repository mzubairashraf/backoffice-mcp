import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { MCP_URL, ORIGIN, READ_ONLY, READ_WRITE, connect, openConsent, registerClient, signIn, submitConsent } from "./helpers";

describe("discovery", () => {
  it("challenges an unauthenticated MCP request and points to the resource metadata", async () => {
    const response = await SELF.fetch(MCP_URL, { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("/.well-known/oauth-protected-resource");
  });

  it("publishes resource and authorization-server metadata", async () => {
    const resource = (await (await SELF.fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
    expect(resource.resource).toBe(MCP_URL);

    const server = (await (await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)).json()) as Record<string, any>;
    expect(server.authorization_endpoint).toBe(`${ORIGIN}/authorize`);
    expect(server.code_challenge_methods_supported).toContain("S256");
    expect(server.scopes_supported).toEqual(["backoffice:read", "backoffice:write", "backoffice:unattended"]);
  });

  it("rejects a made-up bearer token", async () => {
    const response = await SELF.fetch(MCP_URL, { method: "POST", headers: { Authorization: "Bearer not-a-real-token" }, body: "{}" });
    expect(response.status).toBe(401);
  });
});

describe("consent page", () => {
  it("shows the client, where access goes, and each permission", async () => {
    const consent = await openConsent(await registerClient("Acme Assistant"));
    expect(consent.status).toBe(200);
    expect(consent.html).toContain("Acme Assistant");
    expect(consent.html).toContain("localhost"); // redirect host
    expect(consent.html).toContain("an app on your computer"); // loopback warning
    for (const scope of ["backoffice:read", "backoffice:write", "backoffice:unattended"]) {
      expect(consent.html).toContain(`value="${scope}"`);
    }
    // "Skip confirmations" is never pre-selected.
    expect(consent.html).toMatch(/value="backoffice:unattended"\s+>/);
  });

  it("escapes a hostile client name instead of running it", async () => {
    const consent = await openConsent(await registerClient('<script>alert("x")</script>'));
    expect(consent.html).not.toContain("<script>alert");
    expect(consent.html).toContain("&#60;script&#62;");
  });

  it("cannot be framed and allows no scripts", async () => {
    const consent = await openConsent(await registerClient());
    const csp = consent.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'none'");
  });

  it("refuses an approval posted without the browser's cookie", async () => {
    const consent = await openConsent(await registerClient());
    const forged = await submitConsent({ handle: consent.handle, user: "victim", scopes: READ_WRITE });
    expect(forged.status).toBe(400);
    expect(forged.headers.get("Location")).toBeNull();
  });

  it("refuses a handle that was already used", async () => {
    const consent = await openConsent(await registerClient());
    const first = await submitConsent({ handle: consent.handle, cookie: consent.cookie, user: "replay", scopes: READ_ONLY });
    expect(first.status).toBe(302);
    const second = await submitConsent({ handle: consent.handle, cookie: consent.cookie, user: "replay", scopes: READ_ONLY });
    expect(second.status).toBe(400);
  });

  it("sends the user back with access_denied when they click Deny", async () => {
    const consent = await openConsent(await registerClient());
    const denied = await submitConsent({ handle: consent.handle, cookie: consent.cookie, user: "nope", scopes: [], decision: "deny" });
    expect(denied.status).toBe(302);
    expect(denied.headers.get("Location")).toContain("error=access_denied");
  });
});

describe("grants", () => {
  it("issues a token limited to the scopes the user ticked", async () => {
    const { scope } = await signIn("scoped", READ_ONLY);
    expect(scope.split(" ")).toEqual(["backoffice:read"]);
  });

  it("always includes read access and ignores scopes the server does not define", async () => {
    const { scope } = await signIn("extra", ["backoffice:write", "admin:everything"]);
    expect(scope.split(" ").sort()).toEqual(["backoffice:read", "backoffice:write"]);
  });

  it("lets a signed-in client list and call tools", async () => {
    const { token } = await signIn("alice");
    const { client } = await connect(token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "create_customer",
      "create_draft_invoice",
      "get_customer",
      "get_invoice",
      "get_receivables_summary",
      "list_audit_log",
      "list_customers",
      "list_invoices",
      "record_payment",
      "send_invoice",
      "void_invoice"
    ]);
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      const write = ["create_customer", "create_draft_invoice", "record_payment", "send_invoice", "void_invoice"].includes(tool.name);
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(!write);
    }
    for (const name of ["record_payment", "send_invoice", "void_invoice"]) {
      expect(tools.find((t) => t.name === name)?.annotations?.destructiveHint, name).toBe(true);
    }
  });
});
