export type InvoiceStatus = "draft" | "open" | "paid" | "void";

export interface Customer {
  id: string;
  name: string;
  email: string | null;
  created_at: string;
}

export interface InvoiceLine {
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
}

export interface Invoice {
  id: string;
  number: string;
  customer_id: string;
  customer_name: string;
  status: InvoiceStatus;
  currency: string;
  total: number;
  amount_paid: number;
  amount_due: number;
  due_date: string;
  overdue: boolean;
  memo: string | null;
  created_at: string;
  sent_at: string | null;
}

export interface InvoiceDetail extends Invoice {
  lines: InvoiceLine[];
  payments: Payment[];
}

export interface Payment {
  id: string;
  invoice_id: string;
  amount: number;
  method: string;
  reference: string | null;
  received_at: string;
}

export interface AuditEntry {
  at: string;
  client_id: string | null;
  tool: string;
  outcome: string;
  summary: string | null;
}

export interface Page<T> {
  items: T[];
  has_more: boolean;
  next_cursor?: string;
}
