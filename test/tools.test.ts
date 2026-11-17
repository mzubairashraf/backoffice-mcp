import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { ALL_SCOPES, READ_ONLY, READ_WRITE, expectError, expectOk, rawMcp, session, signIn } from "./helpers";
import type { Session } from "./helpers";

const key = () => `test-${crypto.randomUUID()}`;

/** Finds a seeded invoice by its number. */
async function invoiceByNumber(s: Session, number: string) {
  const list = await s.call("list_invoices", { limit: 100 });
  expectOk(list);
  const invoice = list.data.items.find((i: { number: string }) => i.number === number);
  if (!invoice) throw new Error(`no invoice ${number}`);
  return invoice as { id: string; number: string; status: string; total: number; amount_paid: number; amount_due: number; customer_id: string };
}

describe("reading the workspace", () => {
  it("gives a new user sample data and a correct receivables summary", async () => {
    const s = await session("reader");
    const summary = await s.call("get_receivables_summary");
    expectOk(summary);
    // Seed: INV-0002 320,000 (20 days late), INV-0003 75,000 left (70 days late), INV-0004 125,000 (not due).
    expect(summary.data.currencies).toEqual([
      {
        currency: "USD",
        open_invoices: 3,
        total_due: 520_000,
        overdue_invoices: 2,
        overdue_due: 395_000,
        aging: { not_yet_due: 125_000, days_1_30: 320_000, days_31_60: 0, days_over_60: 75_000 }
      }
    ]);
  });

  it("filters invoices by status and by overdue", async () => {
    const s = await session("filters");
    const table: [Record<string, unknown>, string[]][] = [
      [{ status: "draft" }, ["INV-0005"]],
      [{ status: "paid" }, ["INV-0001"]],
      [{ status: "open" }, ["INV-0002", "INV-0003", "INV-0004"]],
      [{ overdue_only: true }, ["INV-0002", "INV-0003"]],
      [{ status: "void" }, []]
    ];
    for (const [args, want] of table) {
      const result = await s.call("list_invoices", args);
      expectOk(result);
      expect(result.data.items.map((i: { number: string }) => i.number).sort(), JSON.stringify(args)).toEqual(want);
    }
  });

  it("pages without gaps or repeats", async () => {
    const s = await session("pager");
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await s.call("list_invoices", { limit: 2, ...(cursor ? { cursor } : {}) });
      expectOk(page);
      seen.push(...page.data.items.map((i: { number: string }) => i.number));
      cursor = page.data.next_cursor;
      expect(page.data.has_more).toBe(Boolean(cursor));
    } while (cursor);
    expect(seen.sort()).toEqual(["INV-0001", "INV-0002", "INV-0003", "INV-0004", "INV-0005"]);
  });

  it("returns line items and payments for one invoice", async () => {
    const s = await session("detail");
    const partPaid = await invoiceByNumber(s, "INV-0003");
    const detail = await s.call("get_invoice", { invoice_id: partPaid.id });
    expectOk(detail);
    expect(detail.data).toMatchObject({ total: 125_000, amount_paid: 50_000, amount_due: 75_000, overdue: true, customer_name: "Contoso Logistics" });
    expect(detail.data.lines).toHaveLength(1);
    expect(detail.data.payments).toHaveLength(1);
  });
});

describe("input validation", () => {
  it("rejects malformed arguments before touching the database", async () => {
    const s = await session("validator");
    const table: [string, Record<string, unknown>][] = [
      ["get_invoice", { invoice_id: "inv_x/../../customers" }],
      ["get_invoice", { invoice_id: "cus_abcdef123" }],
      ["get_customer", { customer_id: "' OR 1=1 --" }],
      ["list_invoices", { status: "overdue" }],
      ["list_invoices", { limit: 1000 }],
      ["list_invoices", { unknown_filter: true }],
      ["create_customer", { name: "", idempotency_key: key() }],
      ["create_customer", { name: "Acme", email: "not-an-email", idempotency_key: key() }],
      ["create_customer", { name: "Acme" }], // no idempotency key
      ["create_customer", { name: "Acme", idempotency_key: "short" }],
      ["record_payment", { invoice_id: "inv_abcdef123", amount: 10.5, method: "card", idempotency_key: key() }],
      ["record_payment", { invoice_id: "inv_abcdef123", amount: -100, method: "card", idempotency_key: key() }],
      ["record_payment", { invoice_id: "inv_abcdef123", amount: 100, method: "bitcoin", idempotency_key: key() }]
    ];
    for (const [tool, args] of table) {
      const result = await s.call(tool, args);
      expect(result.ok, `${tool} ${JSON.stringify(args)}`).toBe(false);
    }
    const customers = await s.call("list_customers");
    expectOk(customers);
    expect(customers.data.items).toHaveLength(3); // only the seeded ones
  });

  it("reports a missing object as not_found", async () => {
    const s = await session("missing");
    const result = await s.call("get_invoice", { invoice_id: "inv_doesnotexist" });
    expectError(result);
    expect(result.error.code).toBe("not_found");
  });
});

describe("tenant isolation", () => {
  it("never shows or changes another user's data", async () => {
    const alice = await session("alice-iso", ALL_SCOPES);
    const mallory = await session("mallory-iso", ALL_SCOPES);

    const created = await alice.call("create_customer", { name: "Alice Secret Client", idempotency_key: key() });
    expectOk(created);
    const aliceInvoice = await invoiceByNumber(alice, "INV-0002");

    // Mallory knows the exact IDs and still gets nothing.
    const peek = await mallory.call("get_customer", { customer_id: created.data.customer.id });
    expectError(peek);
    expect(peek.error.code).toBe("not_found");

    const read = await mallory.call("get_invoice", { invoice_id: aliceInvoice.id });
    expectError(read);
    expect(read.error.code).toBe("not_found");

    for (const [tool, args] of [
      ["record_payment", { invoice_id: aliceInvoice.id, amount: 100, method: "cash", idempotency_key: key() }],
      ["void_invoice", { invoice_id: aliceInvoice.id }],
      ["create_draft_invoice", { customer_id: created.data.customer.id, currency: "USD", due_date: "2030-01-01", lines: [{ description: "x", quantity: 1, unit_price: 1 }], idempotency_key: key() }]
    ] as const) {
      const attempt = await mallory.call(tool, args);
      expectError(attempt);
      expect(attempt.error.code, tool).toBe("not_found");
    }

    const names = await mallory.call("list_customers", { limit: 100 });
    expectOk(names);
    expect(JSON.stringify(names.data)).not.toContain("Alice Secret Client");

    const untouched = await alice.call("get_invoice", { invoice_id: aliceInvoice.id });
    expectOk(untouched);
    expect(untouched.data).toMatchObject({ status: "open", amount_paid: 0 });
  });
});

describe("permissions", () => {
  it("lets a read-only connection read and refuses every write", async () => {
    const s = await session("readonly", READ_ONLY);
    expectOk(await s.call("get_receivables_summary"));
    const open = await invoiceByNumber(s, "INV-0002");
    const draft = await invoiceByNumber(s, "INV-0005");

    const writes: [string, Record<string, unknown>][] = [
      ["create_customer", { name: "Nope", idempotency_key: key() }],
      ["create_draft_invoice", { customer_id: open.customer_id, currency: "USD", due_date: "2030-01-01", lines: [{ description: "x", quantity: 1, unit_price: 1 }], idempotency_key: key() }],
      ["send_invoice", { invoice_id: draft.id }],
      ["record_payment", { invoice_id: open.id, amount: 100, method: "cash", idempotency_key: key() }],
      ["void_invoice", { invoice_id: open.id }]
    ];
    for (const [tool, args] of writes) {
      const result = await s.call(tool, args);
      expectError(result);
      expect(result.error.code, tool).toBe("permission_denied");
    }
    expect(s.prompts).toEqual([]); // refused before the user is ever asked

    const customers = await s.call("list_customers");
    expectOk(customers);
    expect(customers.data.items).toHaveLength(3);
    expect(await invoiceByNumber(s, "INV-0002")).toMatchObject({ status: "open", amount_paid: 0 });
    expect(await invoiceByNumber(s, "INV-0005")).toMatchObject({ status: "draft" });
  });
});

describe("idempotent writes", () => {
  it("returns the original customer when a create is retried", async () => {
    const s = await session("idem-customer");
    const args = { name: "Repeat Ltd", email: "ap@repeat.example", idempotency_key: key() };
    const first = await s.call("create_customer", args);
    const second = await s.call("create_customer", args);
    expectOk(first);
    expectOk(second);
    expect(first.data.replayed).toBe(false);
    expect(second.data.replayed).toBe(true);
    expect(second.data.customer.id).toBe(first.data.customer.id);

    const all = await s.call("list_customers", { limit: 100 });
    expectOk(all);
    expect(all.data.items.filter((c: { name: string }) => c.name === "Repeat Ltd")).toHaveLength(1);
  });

  it("refuses a key that is reused for a different request", async () => {
    const s = await session("idem-conflict");
    const k = key();
    expectOk(await s.call("create_customer", { name: "First", idempotency_key: k }));
    const clash = await s.call("create_customer", { name: "Second", idempotency_key: k });
    expectError(clash);
    expect(clash.error).toMatchObject({ code: "idempotency_conflict", field: "idempotency_key" });
  });

  it("computes the invoice total and does not burn an invoice number on a retry", async () => {
    const s = await session("idem-invoice");
    const customer = (await invoiceByNumber(s, "INV-0005")).customer_id;
    const args = {
      customer_id: customer,
      currency: "USD",
      due_date: "2030-06-30",
      memo: "Three days of consulting",
      lines: [
        { description: "Consulting day", quantity: 3, unit_price: 120_000 },
        { description: "Travel", quantity: 1, unit_price: 18_550 }
      ],
      idempotency_key: key()
    };
    const first = await s.call("create_draft_invoice", args);
    const retry = await s.call("create_draft_invoice", args);
    expectOk(first);
    expectOk(retry);
    expect(first.data.invoice).toMatchObject({ number: "INV-0006", status: "draft", total: 378_550, amount_due: 0 });
    expect(first.data.invoice.lines).toHaveLength(2);
    expect(retry.data).toMatchObject({ replayed: true, invoice: { id: first.data.invoice.id, number: "INV-0006" } });

    const next = await s.call("create_draft_invoice", { ...args, idempotency_key: key() });
    expectOk(next);
    expect(next.data.invoice.number).toBe("INV-0007");
  });

  it("records a payment once however many times the same request arrives", async () => {
    const s = await session("idem-payment", ALL_SCOPES);
    const invoice = await invoiceByNumber(s, "INV-0002");
    const args = { invoice_id: invoice.id, amount: 100_000, method: "bank_transfer", reference: "WIRE-1", idempotency_key: key() };

    // Ten identical requests at once, as a client retrying after timeouts would send.
    const results = await Promise.all(Array.from({ length: 10 }, () => s.call("record_payment", args)));
    for (const result of results) expectOk(result);
    const ids = new Set(results.map((r) => (r.ok ? r.data.payment.id : "")));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.ok && r.data.replayed === false)).toHaveLength(1);

    const after = await s.call("get_invoice", { invoice_id: invoice.id });
    expectOk(after);
    expect(after.data).toMatchObject({ amount_paid: 100_000, amount_due: 220_000, status: "open" });
    expect(after.data.payments).toHaveLength(1);
  });
});

describe("payments and invoice state", () => {
  it("moves an invoice from draft to open to paid", async () => {
    const s = await session("lifecycle");
    const draft = await invoiceByNumber(s, "INV-0005");

    const early = await s.call("record_payment", { invoice_id: draft.id, amount: 1000, method: "card", idempotency_key: key() });
    expectError(early);
    expect(early.error.code).toBe("invalid_state");

    const sent = await s.call("send_invoice", { invoice_id: draft.id });
    expectOk(sent);
    expect(sent.data).toMatchObject({ changed: true, invoice: { status: "open", amount_due: 90_000 } });
    const again = await s.call("send_invoice", { invoice_id: draft.id });
    expectOk(again);
    expect(again.data.changed).toBe(false);

    const tooMuch = await s.call("record_payment", { invoice_id: draft.id, amount: 90_001, method: "card", idempotency_key: key() });
    expectError(tooMuch);
    expect(tooMuch.error).toMatchObject({ code: "invalid_input", field: "amount" });

    const part = await s.call("record_payment", { invoice_id: draft.id, amount: 40_000, method: "card", idempotency_key: key() });
    expectOk(part);
    expect(part.data.invoice).toMatchObject({ status: "open", amount_paid: 40_000, amount_due: 50_000 });

    const rest = await s.call("record_payment", { invoice_id: draft.id, amount: 50_000, method: "bank_transfer", idempotency_key: key() });
    expectOk(rest);
    expect(rest.data.invoice).toMatchObject({ status: "paid", amount_paid: 90_000, amount_due: 0 });

    const extra = await s.call("record_payment", { invoice_id: draft.id, amount: 1, method: "cash", idempotency_key: key() });
    expectError(extra);
    expect(extra.error.code).toBe("invalid_state");
  });

  it("voids only invoices that have no payments", async () => {
    const s = await session("voider");
    const unpaid = await invoiceByNumber(s, "INV-0004");
    const partPaid = await invoiceByNumber(s, "INV-0003");
    const paid = await invoiceByNumber(s, "INV-0001");

    const ok = await s.call("void_invoice", { invoice_id: unpaid.id });
    expectOk(ok);
    expect(ok.data).toMatchObject({ changed: true, invoice: { status: "void", amount_due: 0 } });
    const repeat = await s.call("void_invoice", { invoice_id: unpaid.id });
    expectOk(repeat);
    expect(repeat.data.changed).toBe(false);

    for (const invoice of [partPaid, paid]) {
      const refused = await s.call("void_invoice", { invoice_id: invoice.id });
      expectError(refused);
      expect(refused.error.code, invoice.number).toBe("invalid_state");
    }
  });
});

describe("human confirmation", () => {
  it("asks the user, in plain words, before an irreversible action", async () => {
    const s = await session("confirm-yes");
    const invoice = await invoiceByNumber(s, "INV-0002");
    const paid = await s.call("record_payment", { invoice_id: invoice.id, amount: 75_050, method: "bank_transfer", idempotency_key: key() });
    expectOk(paid);
    expect(s.prompts).toEqual(["Record a bank transfer payment of 750.50 USD on invoice INV-0002 (Northwind Traders, 3,200.00 USD due)?"]);
  });

  it("does not ask for reads or for reversible writes", async () => {
    const s = await session("confirm-none-needed");
    expectOk(await s.call("get_receivables_summary"));
    expectOk(await s.call("create_customer", { name: "Quiet Co", idempotency_key: key() }));
    expect(s.prompts).toEqual([]);
  });

  it.each(["decline", "untick"] as const)("changes nothing when the user answers with %s", async (answer) => {
    const s = await session(`confirm-${answer}`, READ_WRITE, answer);
    const open = await invoiceByNumber(s, "INV-0002");
    const draft = await invoiceByNumber(s, "INV-0005");

    const attempts: [string, Record<string, unknown>][] = [
      ["record_payment", { invoice_id: open.id, amount: 5000, method: "cash", idempotency_key: key() }],
      ["void_invoice", { invoice_id: open.id }],
      ["send_invoice", { invoice_id: draft.id }]
    ];
    for (const [tool, args] of attempts) {
      const result = await s.call(tool, args);
      expectError(result);
      expect(result.error.code, tool).toBe("confirmation_declined");
    }
    expect(s.prompts).toHaveLength(3);
    expect(await invoiceByNumber(s, "INV-0002")).toMatchObject({ status: "open", amount_paid: 0 });
    expect(await invoiceByNumber(s, "INV-0005")).toMatchObject({ status: "draft" });
  });

  it.each([
    ["a current app without confirmation support", "none", "modern"],
    ["an older (2025-era) app", "accept", "legacy"]
  ] as const)("refuses irreversible actions from %s, and says how to allow them", async (_label, confirm, era) => {
    const s = await session(`confirm-incapable-${era}`, READ_WRITE, confirm, era);
    const invoice = await invoiceByNumber(s, "INV-0002");

    const attempts: [string, Record<string, unknown>][] = [
      ["void_invoice", { invoice_id: invoice.id }],
      ["record_payment", { invoice_id: invoice.id, amount: 100, method: "cash", idempotency_key: key() }]
    ];
    for (const [tool, args] of attempts) {
      const result = await s.call(tool, args);
      expectError(result);
      expect(result.error.code, tool).toBe("confirmation_unavailable");
      expect(result.error.message).toContain("Skip confirmations");
    }
    expect(s.prompts).toEqual([]);
    expect(await invoiceByNumber(s, "INV-0002")).toMatchObject({ status: "open", amount_paid: 0 });

    // Reads and reversible writes still work for such an app.
    expectOk(await s.call("get_receivables_summary"));
    expectOk(await s.call("create_customer", { name: "Still Fine", idempotency_key: key() }));
  });

  it.each(["modern", "legacy"] as const)("skips the question only when the user granted 'skip confirmations' at sign-in (%s app)", async (era) => {
    const s = await session(`confirm-unattended-${era}`, ALL_SCOPES, "none", era);
    const invoice = await invoiceByNumber(s, "INV-0004");
    const result = await s.call("void_invoice", { invoice_id: invoice.id });
    expectOk(result);
    expect(result.data.invoice.status).toBe("void");
  });
});

describe("confirmation cannot be reused", () => {
  // The server is stateless, so the user's "yes" travels back through the
  // client together with a signed state. These tests replay a real approved
  // request with one thing changed, as a compromised client might.
  async function approvedPayment(user: string) {
    const s = await session(user);
    const invoice = await invoiceByNumber(s, "INV-0002");
    const paid = await s.call("record_payment", { invoice_id: invoice.id, amount: 1000, method: "cash", idempotency_key: key() });
    expectOk(paid);
    const approved = s.sent.filter((r) => r.body.includes("record_payment") && r.body.includes("inputResponses")).pop();
    if (!approved) throw new Error("did not capture the approved request");
    return { s, invoice, approved };
  }

  it("accepts the untouched approved request again, as a plain retry (control)", async () => {
    const { s, invoice, approved } = await approvedPayment("replay-control");
    const response = await rawMcp(approved.headers, approved.body);
    expect(response.status).toBe(200);
    expect(response.text).toContain("replayed");
    expect(response.text).toContain("true");

    const after = await s.call("get_invoice", { invoice_id: invoice.id });
    expectOk(after);
    expect(after.data.amount_paid).toBe(1000); // the retry did not pay twice
  });

  it("rejects an approved request whose amount was changed afterwards", async () => {
    const { s, invoice, approved } = await approvedPayment("replay-amount");
    const tampered = JSON.parse(approved.body);
    tampered.params.arguments.amount = 300_000;
    tampered.params.arguments.idempotency_key = key();

    const response = await rawMcp(approved.headers, JSON.stringify(tampered));
    expect(response.text).toContain("arguments changed");

    const after = await s.call("get_invoice", { invoice_id: invoice.id });
    expectOk(after);
    expect(after.data.amount_paid).toBe(1000); // only the payment the user approved
  });

  it("rejects one user's approval presented with another user's token", async () => {
    const { approved } = await approvedPayment("replay-victim");
    const attacker = await signIn("replay-attacker");
    const response = await rawMcp({ ...approved.headers, authorization: `Bearer ${attacker.token}` }, approved.body);
    expect(response.text).not.toContain('"payment"');
    expect(response.text).toMatch(/error/i);
  });

  it("rejects an approval whose signed state was altered", async () => {
    const { s, invoice, approved } = await approvedPayment("replay-forged");
    const forged = JSON.parse(approved.body);
    forged.params.requestState = String(forged.params.requestState).replace(/.$/, (c: string) => (c === "A" ? "B" : "A"));
    forged.params.arguments.idempotency_key = key();
    const response = await rawMcp(approved.headers, JSON.stringify(forged));
    expect(response.text).not.toContain('"payment"');

    const after = await s.call("get_invoice", { invoice_id: invoice.id });
    expectOk(after);
    expect(after.data.amount_paid).toBe(1000);
  });
});

describe("audit log", () => {
  it("records every call with its outcome and no personal data", async () => {
    const s = await session("auditor");
    const created = await s.call("create_customer", { name: "Private Person", email: "private@person.example", idempotency_key: key() });
    expectOk(created);
    expectError(await s.call("get_invoice", { invoice_id: "inv_doesnotexist" }));

    const log = await s.call("list_audit_log", { limit: 10 });
    expectOk(log);
    const entries = log.data.entries as { tool: string; outcome: string; summary: string | null; client_id: string | null }[];
    expect(entries.map((e) => `${e.tool}:${e.outcome}`)).toEqual(["get_invoice:not_found", "create_customer:ok"]);
    expect(entries[1].summary).toBe(created.data.customer.id);
    expect(entries.every((e) => e.client_id)).toBe(true);

    const stored = await env.DB.prepare("SELECT * FROM audit_log").all();
    const dump = JSON.stringify(stored.results);
    expect(dump).not.toContain("Private Person");
    expect(dump).not.toContain("private@person.example");
  });
});
