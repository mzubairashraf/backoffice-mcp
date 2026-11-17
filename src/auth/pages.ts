import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

import { SCOPES } from "./scopes";

/**
 * Every value on these pages that came from an MCP client (its name, its
 * redirect host) is attacker-chosen: any client can register itself. All of
 * it goes through escape() before it reaches HTML.
 */
export const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const STYLE = `
  :root { color-scheme: light dark; --fg:#16181d; --muted:#5b6472; --bg:#f6f7f9; --card:#fff; --line:#d9dde3; --accent:#4b45e6; --warn:#9a5b00; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e8eaee; --muted:#9aa3b2; --bg:#111318; --card:#1a1d24; --line:#2c313b; --accent:#8f8bff; --warn:#e0a84a; } }
  body { font: 16px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); margin: 0; padding: 32px 16px; }
  main { max-width: 560px; margin: 0 auto; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 28px; }
  h1 { font-size: 22px; margin: 0 0 8px; } h2 { font-size: 16px; margin: 24px 0 8px; }
  p { margin: 8px 0; } .muted { color: var(--muted); font-size: 14px; } .warn { color: var(--warn); }
  label.scope { display: block; padding: 12px; border: 1px solid var(--line); border-radius: 8px; margin: 8px 0; }
  label.scope span { display: block; font-weight: 600; } label.scope small { color: var(--muted); }
  input[type=text] { width: 100%; box-sizing: border-box; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; font: inherit; }
  .actions { display: flex; gap: 12px; margin-top: 24px; }
  button { font: inherit; padding: 10px 18px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: inherit; cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; flex: 1; }
  code { background: var(--bg); padding: 2px 6px; border-radius: 4px; font-size: 14px; word-break: break-all; }
`;

const layout = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;

export function consentPage(details: ConsentDescription, handle: string, mode: "github" | "demo"): string {
  const name = escape(details.clientName || "An MCP client");
  const publisher = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : "This app registered itself, so its name is not verified.";
  // No scripts run on this page (see the Content-Security-Policy), so the
  // always-granted scope is a disabled, ticked box. The server adds it to
  // every grant regardless of what the form sends.
  const scopes = SCOPES.map((scope) => {
    const state = scope.required ? "checked disabled" : scope.defaultOn ? "checked" : "";
    return `<label class="scope">
      <span><input type="checkbox" name="scope" value="${escape(scope.id)}" ${state}> ${escape(scope.label)}</span>
      <small>${escape(scope.detail)}</small>
    </label>`;
  }).join("");
  const signIn =
    mode === "demo"
      ? `<h2>Demo sign-in</h2>
         <p class="muted">Local development mode. Pick any workspace name; there is no password.</p>
         <input type="text" name="demo_user" value="demo" pattern="[a-z0-9-]{1,32}" required>`
      : `<p class="muted">Next you will sign in with GitHub. It is used only to identify you; no repository access is requested.</p>`;

  return layout(
    `Authorize ${details.clientName}`,
    `<h1>Allow ${name} to use your back office?</h1>
     <p>${publisher} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
     ${details.redirectIsLoopback ? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>' : ""}
     <form method="post">
       <input type="hidden" name="handle" value="${escape(handle)}">
       <h2>What it may do</h2>
       ${scopes}
       ${signIn}
       <div class="actions">
         <button name="decision" value="deny">Deny</button>
         <button class="primary" name="decision" value="approve">${mode === "demo" ? "Allow" : "Allow and sign in with GitHub"}</button>
       </div>
     </form>`
  );
}

export function messagePage(title: string, message: string): string {
  return layout(title, `<h1>${escape(title)}</h1><p>${escape(message)}</p>`);
}

export function homePage(mcpUrl: string): string {
  const url = escape(mcpUrl);
  return layout(
    "Invoicing Back Office MCP server",
    `<h1>Invoicing Back Office MCP server</h1>
     <p>A remote <a href="https://modelcontextprotocol.io">Model Context Protocol</a> server that lets an AI assistant work with a small invoicing system: customers, invoices and payments.</p>
     <p>It is a reference implementation of how to connect an agent to a business system safely. Each person who signs in gets a private workspace with sample data.</p>
     <h2>Connect</h2>
     <p>Add this URL as a remote MCP server (a "custom connector") in your MCP client:</p>
     <p><code>${url}</code></p>
     <p class="muted">Your client opens a sign-in page where you choose what the assistant may do.</p>
     <h2>What to try</h2>
     <p class="muted">"Who owes us money and how overdue is it?" &middot; "Draft an invoice to Fabrikam Studio for 3 days of consulting." &middot; "Record a bank transfer of $750 on INV-0003."</p>
     <h2>Safety</h2>
     <p class="muted">Read-only by choice at sign-in. Sending or voiding an invoice and recording a payment ask you to confirm. Retried writes cannot be applied twice. Every tool call is in the audit log.</p>
     <p class="muted">Source: <a href="https://github.com/mzubairashraf/backoffice-mcp">github.com/mzubairashraf/backoffice-mcp</a></p>`
  );
}
