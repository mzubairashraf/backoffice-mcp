# backoffice-mcp

[![CI](https://github.com/mzubairashraf/backoffice-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/mzubairashraf/backoffice-mcp/actions/workflows/ci.yml)

A remote [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI assistant work with a small invoicing back office: customers, invoices and payments. It is written in TypeScript, runs on Cloudflare Workers, and signs users in with OAuth 2.1.

It is a reference implementation of one question: **how do you let an agent act on a business system without letting it do damage?** The business system here is deliberately small so the safety design is easy to read.

| Risk when an agent can write to your system | What this server does |
| --- | --- |
| It does more than the user intended | The user picks permissions on the sign-in page; read-only is one untick away. Every tool checks its scope on every call. |
| It takes an irreversible action on its own | Sending or voiding an invoice and recording a payment stop and ask the user to confirm, through the client application, outside the model's control. |
| A retry after a timeout applies a payment twice | Writes take an idempotency key. The database, not the application, guarantees the action happens once. |
| An approval for one action is reused for another | The user's "yes" is bound to that user, that tool and those exact arguments with a signed, expiring state. |
| One user's assistant reaches another user's data | The user ID comes from the verified token and is part of every query. No tool accepts it as input. |
| Nobody can tell afterwards what the agent did | Every tool call is in an audit log that the user can ask the assistant to read back. |
| Text in the data steers the model | Tool results are structured data, and the server tells the model that names, memos and references are data, not instructions. The server-side protections above do not depend on the model obeying. |

About 1,500 lines of TypeScript and 750 lines of tests.

## Try it

A live instance runs at **https://backoffice-mcp.zashraf-b88.workers.dev**. Add this URL as a remote MCP server ("custom connector") in an MCP client such as Claude:

```
https://backoffice-mcp.zashraf-b88.workers.dev/mcp
```

Your client opens the sign-in page, where you choose what the assistant may do and sign in with GitHub (used only to identify you; no repository access is requested). Each person gets a private workspace with sample data.

Things to ask:

- "Who owes us money, and how overdue is it?"
- "Draft an invoice to Fabrikam Studio for three days of consulting at $1,200 a day."
- "Record a bank transfer of $750 against INV-0003."
- "What did you change in the last hour?"

## Tools

| Tool | Access | What it does |
| --- | --- | --- |
| `get_receivables_summary` | read | Open and overdue totals per currency, with an aging breakdown. |
| `list_customers`, `get_customer` | read | Customers, and one customer's open balance. |
| `list_invoices`, `get_invoice` | read | Filter by status, customer or overdue; one invoice with lines and payments. |
| `list_audit_log` | read | Recent tool calls in this workspace and their outcomes. |
| `create_customer` | write | Idempotent create. |
| `create_draft_invoice` | write | Draft invoice; total computed from the lines. A draft owes nothing and can be voided. |
| `send_invoice` | write, confirmed | Draft becomes open. |
| `record_payment` | write, confirmed | Payment against an open invoice; cannot exceed what is due. |
| `void_invoice` | write, confirmed | Voids a draft or an unpaid open invoice. |

Amounts are integers in the smallest currency unit. A failed call returns a structured error the model can act on:

```json
{"error":{"code":"invalid_input","message":"Amount exceeds what is still due on INV-0005 (90000 USD in minor units)","field":"amount"}}
```

Codes: `invalid_input`, `not_found`, `invalid_state`, `idempotency_conflict`, `permission_denied`, `confirmation_declined`, `confirmation_unavailable`, `internal_error`.

## How it works

```
MCP client ──HTTPS──▶ Cloudflare Worker
                       ├─ OAuth 2.1 authorization server   (consent page, tokens; state in KV)
                       ├─ /mcp, stateless MCP handler      (a fresh server per request)
                       └─ D1 (SQLite)                      (customers, invoices, payments, audit log)
```

- `src/index.ts` wires the OAuth provider in front of the MCP handler.
- `src/auth/` is the consent page and the GitHub sign-in.
- `src/mcp/server.ts` defines the tools and the wrapper every tool goes through: scope check, confirmation, error contract, audit entry.
- `src/domain/store.ts` is the data layer. It is constructed with a user ID and has no method that takes one.

### Sign-in and permissions

The Worker is its own authorization server, built on `@cloudflare/workers-oauth-provider`: PKCE, dynamic client registration and Client ID Metadata Documents, and tokens bound to this server's URL so they are useless anywhere else.

The consent page asks the user to approve **this client** before sending them to GitHub. GitHub only establishes who the user is; its token is used once to read the public profile and is not stored. The page shows where access will be sent, warns when that is an app on the local machine, escapes everything the client supplied, allows no scripts and cannot be framed. Its form carries only a single-use handle tied to the browser by a cookie, so it cannot be forged from another site.

Three scopes: `backoffice:read` (always granted), `backoffice:write` (ticked by default) and `backoffice:unattended` (never ticked by default).

### Confirmation

Irreversible tools return an MCP elicitation instead of acting. The client application shows the question, for example "Record a bank transfer payment of 750.50 USD on invoice INV-0002 (Northwind Traders, 3,200.00 USD due)?", and retries the call with the answer. The model never sees a parameter it could set to skip this.

Because the server is stateless, the answer comes back through the client. It is accepted only with a state value the server signed (HMAC-SHA256, ten-minute expiry) over the user, the tool and a hash of the arguments. The tests replay a real approved request with the amount changed, with another user's token, and with the signature altered; all three are refused.

Clients that cannot show a prompt, including 2025-era clients on this stateless endpoint, get `confirmation_unavailable` with an explanation, and nothing changes. A user who wants such a client to act anyway grants `backoffice:unattended` at sign-in.

### Idempotent writes

For each create, the new row's primary key is a hash of the user, the tool and the caller's `idempotency_key`. A repeat of the same request collides on the primary key, the transaction rolls back, and the original row is returned with `"replayed": true`. A key reused for a different request is refused.

Recording a payment is one transaction of two statements: an insert that only produces a row if the invoice is open and the amount fits what is due, and an update that only applies if that row now exists. The test suite sends ten identical requests at once and checks that exactly one payment exists.

## Run it locally

Requires Node 22 or newer. No Cloudflare account is needed.

```bash
git clone https://github.com/mzubairashraf/backoffice-mcp && cd backoffice-mcp
npm install
npm test
```

To run the server itself, create a local secrets file and database, then start it:

```bash
echo 'CONFIRMATION_SECRET="any-string-of-at-least-32-characters-here"' > .dev.vars
npm run db:migrate:local
npm run dev
```

In a second terminal, `npm run smoke` registers a client, goes through the consent page, gets a token and calls the tools. Locally the server runs in `AUTH_MODE=demo`, where sign-in is a workspace name with no password; the Worker refuses to serve in that mode on anything but localhost.

## Deploy

1. `npx wrangler login`
2. `npx wrangler kv namespace create OAUTH_KV` and `npx wrangler d1 create backoffice-mcp`; put both IDs in the `production` block of `wrangler.jsonc`.
3. Create a GitHub OAuth app whose callback URL is `https://<your-worker>/callback`; put its client ID in `wrangler.jsonc`.
4. `npx wrangler secret put GITHUB_CLIENT_SECRET --env production` and the same for `CONFIRMATION_SECRET` (32 or more random characters).
5. Set `MCP_RESOURCE` to `https://<your-worker>/mcp`, then `npm run db:migrate:remote` and `npm run deploy`.

## Testing

`npm test` runs 39 tests inside the Workers runtime with real D1 and KV bindings, so SQL, transactions and the OAuth provider behave as deployed. The tests drive the server the way a client does: a real OAuth flow, then a real MCP client over HTTP.

- **OAuth:** discovery documents, consent page content and escaping, forged and replayed consent forms, Deny, scope narrowing.
- **Tools:** the receivables arithmetic, filters and paging, argument validation including path and SQL-shaped input.
- **Isolation:** a second user with the exact object IDs gets `not_found` for every read and write.
- **Permissions:** a read-only connection is refused every write before the user is asked anything.
- **Idempotency:** retried creates, key reuse, invoice numbering across retries, ten concurrent payments.
- **Confirmation:** the exact prompt wording, decline and untick, clients that cannot prompt, the unattended scope, and three replay attacks.
- **Audit:** every call is logged, and no names or emails reach the log.

## Limits

- The invoicing system is a demonstration. It has no tax, credit notes, multi-user workspaces or real payment collection.
- Confirmation relies on the client application showing the prompt honestly. That is the trust boundary MCP defines; a hostile client could answer for the user. The scope a user grants is the control over which clients are trusted to that degree.
- There is no rate limiting beyond Cloudflare's platform defaults.
- The audit log records tool calls, not sign-ins or token refreshes.

## Licence

MIT. See [LICENSE](LICENSE).
