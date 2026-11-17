import { DomainError, invalid, invalidState, notFound } from "./errors";
import type { AuditEntry, Customer, Invoice, InvoiceDetail, InvoiceLine, InvoiceStatus, Page, Payment } from "./types";

/**
 * Backoffice is the data layer for one signed-in user's workspace.
 *
 * Two rules hold for every method:
 *
 * 1. Tenant isolation. The user ID is fixed at construction and is part of
 *    every WHERE clause. No method accepts a user ID as an argument, so a
 *    tool cannot be talked into reading another workspace.
 * 2. Writes are atomic and safe to retry. Each write is a single D1 batch
 *    (one transaction). Creates take an idempotency key, from which the new
 *    row's primary key is derived, so a repeated request collides on the key
 *    and returns the original row instead of creating a second one.
 */
export class Backoffice {
  constructor(
    private readonly db: D1Database,
    private readonly userId: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  // ---- workspace ----

  /** Creates the workspace on first use and fills it with sample data. */
  async ensureWorkspace(): Promise<void> {
    const created = await this.db
      .prepare("INSERT OR IGNORE INTO workspaces (user_id, created_at) VALUES (?, ?)")
      .bind(this.userId, this.timestamp())
      .run();
    if (created.meta.changes === 1) {
      await this.seed();
    }
  }

  // ---- customers ----

  async listCustomers(opts: { limit: number; cursor?: string }): Promise<Page<Customer>> {
    const after = decodeCursor(opts.cursor);
    const rows = await this.db
      .prepare(
        `SELECT id, name, email, created_at FROM customers
         WHERE user_id = ?1 AND (?2 IS NULL OR (created_at, id) < (?2, ?3))
         ORDER BY created_at DESC, id DESC LIMIT ?4`
      )
      .bind(this.userId, after?.at ?? null, after?.id ?? null, opts.limit + 1)
      .all<Customer>();
    return page(rows.results, opts.limit, (c) => ({ at: c.created_at, id: c.id }));
  }

  async getCustomer(id: string): Promise<Customer & { open_invoices: number; balance_due: Record<string, number> }> {
    const customer = await this.db
      .prepare("SELECT id, name, email, created_at FROM customers WHERE user_id = ? AND id = ?")
      .bind(this.userId, id)
      .first<Customer>();
    if (!customer) throw notFound("customer", id);

    const open = await this.db
      .prepare(
        `SELECT currency, COUNT(*) AS n, SUM(total - amount_paid) AS due FROM invoices
         WHERE user_id = ? AND customer_id = ? AND status = 'open' GROUP BY currency`
      )
      .bind(this.userId, id)
      .all<{ currency: string; n: number; due: number }>();
    const balance: Record<string, number> = {};
    let count = 0;
    for (const row of open.results) {
      balance[row.currency] = row.due;
      count += row.n;
    }
    return { ...customer, open_invoices: count, balance_due: balance };
  }

  async createCustomer(input: {
    name: string;
    email?: string;
    idempotencyKey: string;
  }): Promise<{ customer: Customer; replayed: boolean }> {
    const id = await this.deriveId("cus", "create_customer", input.idempotencyKey);
    const email = input.email ?? null;
    try {
      await this.db
        .prepare("INSERT INTO customers (id, user_id, name, email, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(id, this.userId, input.name, email, this.timestamp())
        .run();
    } catch (err) {
      if (!isDuplicate(err)) throw err;
      const existing = await this.getCustomer(id);
      if (existing.name !== input.name || existing.email !== email) {
        throw idempotencyConflict();
      }
      return { customer: pickCustomer(existing), replayed: true };
    }
    return { customer: pickCustomer(await this.getCustomer(id)), replayed: false };
  }

  // ---- invoices ----

  async listInvoices(opts: {
    status?: InvoiceStatus;
    customerId?: string;
    overdueOnly?: boolean;
    limit: number;
    cursor?: string;
  }): Promise<Page<Invoice>> {
    const after = decodeCursor(opts.cursor);
    const today = this.today();
    const rows = await this.db
      .prepare(
        `${INVOICE_SELECT}
         WHERE i.user_id = ?1
           AND (?2 IS NULL OR i.status = ?2)
           AND (?3 IS NULL OR i.customer_id = ?3)
           AND (?4 = 0 OR (i.status = 'open' AND i.due_date < ?5))
           AND (?6 IS NULL OR (i.created_at, i.id) < (?6, ?7))
         ORDER BY i.created_at DESC, i.id DESC LIMIT ?8`
      )
      .bind(
        this.userId,
        opts.status ?? null,
        opts.customerId ?? null,
        opts.overdueOnly ? 1 : 0,
        today,
        after?.at ?? null,
        after?.id ?? null,
        opts.limit + 1
      )
      .all<InvoiceRow>();
    return page(
      rows.results.map((r) => toInvoice(r, today)),
      opts.limit,
      (i) => ({ at: i.created_at, id: i.id })
    );
  }

  async getInvoice(id: string): Promise<InvoiceDetail> {
    const row = await this.db.prepare(`${INVOICE_SELECT} WHERE i.user_id = ? AND i.id = ?`).bind(this.userId, id).first<InvoiceRow>();
    if (!row) throw notFound("invoice", id);

    const [lines, payments] = await this.db.batch([
      this.db
        .prepare("SELECT description, quantity, unit_price FROM invoice_lines WHERE user_id = ? AND invoice_id = ? ORDER BY position")
        .bind(this.userId, id),
      this.db
        .prepare(
          "SELECT id, invoice_id, amount, method, reference, received_at FROM payments WHERE user_id = ? AND invoice_id = ? ORDER BY received_at"
        )
        .bind(this.userId, id)
    ]);
    return {
      ...toInvoice(row, this.today()),
      lines: (lines.results as Omit<InvoiceLine, "amount">[]).map((l) => ({ ...l, amount: l.quantity * l.unit_price })),
      payments: payments.results as Payment[]
    };
  }

  /** Totals per currency: what is owed, what is overdue, and how old the debt is. */
  async receivablesSummary(): Promise<
    {
      currency: string;
      open_invoices: number;
      total_due: number;
      overdue_invoices: number;
      overdue_due: number;
      aging: { not_yet_due: number; days_1_30: number; days_31_60: number; days_over_60: number };
    }[]
  > {
    const today = this.today();
    const rows = await this.db
      .prepare(
        `SELECT currency,
                COUNT(*) AS open_invoices,
                SUM(total - amount_paid) AS total_due,
                SUM(CASE WHEN due_date < ?2 THEN 1 ELSE 0 END) AS overdue_invoices,
                SUM(CASE WHEN due_date < ?2 THEN total - amount_paid ELSE 0 END) AS overdue_due,
                SUM(CASE WHEN due_date >= ?2 THEN total - amount_paid ELSE 0 END) AS not_yet_due,
                SUM(CASE WHEN due_date < ?2 AND julianday(?2) - julianday(due_date) <= 30 THEN total - amount_paid ELSE 0 END) AS days_1_30,
                SUM(CASE WHEN julianday(?2) - julianday(due_date) > 30 AND julianday(?2) - julianday(due_date) <= 60 THEN total - amount_paid ELSE 0 END) AS days_31_60,
                SUM(CASE WHEN julianday(?2) - julianday(due_date) > 60 THEN total - amount_paid ELSE 0 END) AS days_over_60
         FROM invoices WHERE user_id = ?1 AND status = 'open' GROUP BY currency ORDER BY currency`
      )
      .bind(this.userId, today)
      .all<Record<string, number> & { currency: string }>();
    return rows.results.map((r) => ({
      currency: r.currency,
      open_invoices: r.open_invoices,
      total_due: r.total_due,
      overdue_invoices: r.overdue_invoices,
      overdue_due: r.overdue_due,
      aging: {
        not_yet_due: r.not_yet_due,
        days_1_30: r.days_1_30,
        days_31_60: r.days_31_60,
        days_over_60: r.days_over_60
      }
    }));
  }

  async createDraftInvoice(input: {
    customerId: string;
    currency: string;
    dueDate: string;
    memo?: string;
    lines: { description: string; quantity: number; unit_price: number }[];
    idempotencyKey: string;
  }): Promise<{ invoice: InvoiceDetail; replayed: boolean }> {
    const id = await this.deriveId("inv", "create_draft_invoice", input.idempotencyKey);
    const total = input.lines.reduce((sum, l) => sum + l.quantity * l.unit_price, 0);
    if (!Number.isSafeInteger(total)) throw invalid("lines", "invoice total is too large");

    // Checked up front so the caller gets "not_found" rather than a foreign-key error.
    await this.getCustomer(input.customerId);

    const statements: D1PreparedStatement[] = [
      this.db.prepare("UPDATE workspaces SET invoice_seq = invoice_seq + 1 WHERE user_id = ?").bind(this.userId),
      this.db
        .prepare(
          `INSERT INTO invoices (id, user_id, customer_id, number, status, currency, total, due_date, memo, created_at)
           SELECT ?1, ?2, ?3, 'INV-' || printf('%04d', invoice_seq), 'draft', ?4, ?5, ?6, ?7, ?8
           FROM workspaces WHERE user_id = ?2`
        )
        .bind(id, this.userId, input.customerId, input.currency, total, input.dueDate, input.memo ?? null, this.timestamp()),
      ...input.lines.map((line, position) =>
        this.db
          .prepare(
            "INSERT INTO invoice_lines (id, user_id, invoice_id, position, description, quantity, unit_price) VALUES (?, ?, ?, ?, ?, ?, ?)"
          )
          .bind(`${id}_l${position}`, this.userId, id, position, line.description, line.quantity, line.unit_price)
      )
    ];

    try {
      await this.db.batch(statements);
    } catch (err) {
      if (!isDuplicate(err)) throw err;
      const existing = await this.getInvoice(id);
      const same =
        existing.customer_id === input.customerId &&
        existing.currency === input.currency &&
        existing.total === total &&
        existing.due_date === input.dueDate;
      if (!same) throw idempotencyConflict();
      return { invoice: existing, replayed: true };
    }
    return { invoice: await this.getInvoice(id), replayed: false };
  }

  /** draft -> open. Calling it again on an open invoice changes nothing. */
  async sendInvoice(id: string): Promise<{ invoice: InvoiceDetail; changed: boolean }> {
    const result = await this.db
      .prepare("UPDATE invoices SET status = 'open', sent_at = ? WHERE user_id = ? AND id = ? AND status = 'draft'")
      .bind(this.timestamp(), this.userId, id)
      .run();
    const invoice = await this.getInvoice(id);
    if (result.meta.changes === 1) return { invoice, changed: true };
    if (invoice.status === "open") return { invoice, changed: false };
    throw invalidState(`Invoice ${invoice.number} is ${invoice.status} and cannot be sent`);
  }

  /** draft or unpaid open -> void. Calling it again on a void invoice changes nothing. */
  async voidInvoice(id: string): Promise<{ invoice: InvoiceDetail; changed: boolean }> {
    const result = await this.db
      .prepare("UPDATE invoices SET status = 'void' WHERE user_id = ? AND id = ? AND status IN ('draft', 'open') AND amount_paid = 0")
      .bind(this.userId, id)
      .run();
    const invoice = await this.getInvoice(id);
    if (result.meta.changes === 1) return { invoice, changed: true };
    if (invoice.status === "void") return { invoice, changed: false };
    if (invoice.amount_paid > 0) {
      throw invalidState(`Invoice ${invoice.number} has payments recorded against it and cannot be voided`);
    }
    throw invalidState(`Invoice ${invoice.number} is ${invoice.status} and cannot be voided`);
  }

  // ---- payments ----

  /**
   * Records a payment against an open invoice.
   *
   * The INSERT only produces a row if the invoice is open and the amount fits
   * what is still due, and the UPDATE only applies if that row now exists.
   * Both run in one transaction, so the invoice balance and the payment list
   * cannot disagree. A retry with the same idempotency key hits the primary
   * key, rolls the transaction back, and returns the first payment.
   */
  async recordPayment(input: {
    invoiceId: string;
    amount: number;
    method: string;
    reference?: string;
    idempotencyKey: string;
  }): Promise<{ payment: Payment; invoice: Invoice; replayed: boolean }> {
    const id = await this.deriveId("pay", "record_payment", input.idempotencyKey);
    let inserted = 0;
    try {
      const [insert] = await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO payments (id, user_id, invoice_id, amount, method, reference, received_at)
             SELECT ?1, ?2, id, ?4, ?5, ?6, ?7 FROM invoices
             WHERE user_id = ?2 AND id = ?3 AND status = 'open' AND total - amount_paid >= ?4`
          )
          .bind(id, this.userId, input.invoiceId, input.amount, input.method, input.reference ?? null, this.timestamp()),
        this.db
          .prepare(
            `UPDATE invoices
             SET amount_paid = amount_paid + ?4,
                 status = CASE WHEN amount_paid + ?4 = total THEN 'paid' ELSE status END
             WHERE user_id = ?2 AND id = ?3
               AND EXISTS (SELECT 1 FROM payments WHERE id = ?1 AND user_id = ?2)`
          )
          .bind(id, this.userId, input.invoiceId, input.amount)
      ]);
      inserted = insert.meta.changes;
    } catch (err) {
      if (!isDuplicate(err)) throw err;
      const existing = await this.getPayment(id);
      if (existing.invoice_id !== input.invoiceId || existing.amount !== input.amount) {
        throw idempotencyConflict();
      }
      return { payment: existing, invoice: stripDetail(await this.getInvoice(input.invoiceId)), replayed: true };
    }

    const invoice = await this.getInvoice(input.invoiceId); // throws not_found for an unknown invoice
    if (inserted === 0) {
      if (invoice.status !== "open") {
        throw invalidState(`Invoice ${invoice.number} is ${invoice.status}; payments can only be recorded on open invoices`);
      }
      throw invalid("amount", `Amount exceeds what is still due on ${invoice.number} (${invoice.amount_due} ${invoice.currency} in minor units)`);
    }
    return { payment: await this.getPayment(id), invoice: stripDetail(invoice), replayed: false };
  }

  private async getPayment(id: string): Promise<Payment> {
    const row = await this.db
      .prepare("SELECT id, invoice_id, amount, method, reference, received_at FROM payments WHERE user_id = ? AND id = ?")
      .bind(this.userId, id)
      .first<Payment>();
    if (!row) throw notFound("payment", id);
    return row;
  }

  // ---- audit ----

  async audit(entry: { clientId?: string; tool: string; outcome: string; summary?: string }): Promise<void> {
    await this.db
      .prepare("INSERT INTO audit_log (user_id, at, client_id, tool, outcome, summary) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(this.userId, this.timestamp(), entry.clientId ?? null, entry.tool, entry.outcome, entry.summary ?? null)
      .run();
  }

  async listAudit(limit: number): Promise<AuditEntry[]> {
    const rows = await this.db
      .prepare("SELECT at, client_id, tool, outcome, summary FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT ?")
      .bind(this.userId, limit)
      .all<AuditEntry>();
    return rows.results;
  }

  // ---- helpers ----

  private timestamp(): string {
    return this.now().toISOString();
  }

  private today(): string {
    return this.timestamp().slice(0, 10);
  }

  /**
   * Derives a row ID from the user, the tool and the caller's idempotency
   * key. The same request always maps to the same ID, which turns "has this
   * been done already?" into a primary-key check the database enforces.
   */
  private async deriveId(prefix: string, tool: string, key: string): Promise<string> {
    const data = new TextEncoder().encode(`${this.userId}\n${tool}\n${key}`);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    const hex = Array.from(digest.slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
    return `${prefix}_${hex}`;
  }

  /** Sample data so a new user has something to ask questions about. */
  private async seed(): Promise<void> {
    const day = (offset: number) => new Date(this.now().getTime() + offset * 86_400_000).toISOString();
    const date = (offset: number) => day(offset).slice(0, 10);
    const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
    const cus = (n: number) => `cus_seed${tag}${n}`;
    const inv = (n: number) => `inv_seed${tag}${n}`;

    const customers: [string, string, string, number][] = [
      [cus(1), "Northwind Traders", "ap@northwind.example", -90],
      [cus(2), "Contoso Logistics", "billing@contoso.example", -60],
      [cus(3), "Fabrikam Studio", "accounts@fabrikam.example", -30]
    ];
    // id, customer, number, status, total, paid, due offset, created offset, line description
    const invoices: [string, string, string, InvoiceStatus, number, number, number, number, string][] = [
      [inv(1), cus(1), "INV-0001", "paid", 480_000, 480_000, -45, -75, "Integration build, phase 1"],
      [inv(2), cus(1), "INV-0002", "open", 320_000, 0, -20, -50, "Integration build, phase 2"],
      [inv(3), cus(2), "INV-0003", "open", 125_000, 50_000, -70, -100, "API support retainer, September"],
      [inv(4), cus(2), "INV-0004", "open", 125_000, 0, 12, -18, "API support retainer, October"],
      [inv(5), cus(3), "INV-0005", "draft", 90_000, 0, 30, -1, "Discovery workshop"]
    ];

    const statements: D1PreparedStatement[] = [
      this.db.prepare("UPDATE workspaces SET invoice_seq = ? WHERE user_id = ?").bind(invoices.length, this.userId)
    ];
    for (const [id, name, email, created] of customers) {
      statements.push(
        this.db.prepare("INSERT INTO customers (id, user_id, name, email, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, this.userId, name, email, day(created))
      );
    }
    for (const [id, customer, number, status, total, paid, due, created, description] of invoices) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO invoices (id, user_id, customer_id, number, status, currency, total, amount_paid, due_date, created_at, sent_at)
             VALUES (?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?)`
          )
          .bind(id, this.userId, customer, number, status, total, paid, date(due), day(created), status === "draft" ? null : day(created)),
        this.db
          .prepare("INSERT INTO invoice_lines (id, user_id, invoice_id, position, description, quantity, unit_price) VALUES (?, ?, ?, 0, ?, 1, ?)")
          .bind(`${id}_l0`, this.userId, id, description, total)
      );
      if (paid > 0) {
        statements.push(
          this.db
            .prepare("INSERT INTO payments (id, user_id, invoice_id, amount, method, reference, received_at) VALUES (?, ?, ?, ?, 'bank_transfer', ?, ?)")
            .bind(`pay_seed${tag}${number.slice(-1)}`, this.userId, id, paid, `Seed payment for ${number}`, day(created + 10))
        );
      }
    }
    await this.db.batch(statements);
  }
}

// ---- row mapping ----

const INVOICE_SELECT = `
  SELECT i.id, i.number, i.customer_id, c.name AS customer_name, i.status, i.currency, i.total,
         i.amount_paid, i.due_date, i.memo, i.created_at, i.sent_at
  FROM invoices i JOIN customers c ON c.id = i.customer_id AND c.user_id = i.user_id`;

type InvoiceRow = Omit<Invoice, "amount_due" | "overdue">;

function toInvoice(row: InvoiceRow, today: string): Invoice {
  return {
    ...row,
    amount_due: row.status === "open" ? row.total - row.amount_paid : 0,
    overdue: row.status === "open" && row.due_date < today
  };
}

function stripDetail(detail: InvoiceDetail): Invoice {
  const { lines: _lines, payments: _payments, ...invoice } = detail;
  return invoice;
}

function pickCustomer(c: Customer): Customer {
  return { id: c.id, name: c.name, email: c.email, created_at: c.created_at };
}

function page<T>(rows: T[], limit: number, key: (row: T) => { at: string; id: string }): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const result: Page<T> = { items, has_more: hasMore };
  if (hasMore) result.next_cursor = encodeCursor(key(items[items.length - 1]));
  return result;
}

function encodeCursor(c: { at: string; id: string }): string {
  return btoa(`${c.at}|${c.id}`);
}

function decodeCursor(cursor: string | undefined): { at: string; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    const [at, id] = atob(cursor).split("|");
    if (at && id) return { at, id };
  } catch {
    // fall through
  }
  throw invalid("cursor", "cursor is not valid; pass next_cursor from the previous page unchanged");
}

function isDuplicate(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed: \w+\.id/.test(err.message);
}

function idempotencyConflict(): DomainError {
  return new DomainError(
    "idempotency_conflict",
    "This idempotency_key was already used for a different request. Use a new key for a new action.",
    "idempotency_key"
  );
}
