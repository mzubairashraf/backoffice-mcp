/**
 * OAuth scopes. The consent page lets the user grant fewer than the client
 * asked for, and every tool checks its scope on each call.
 */
export const SCOPE_READ = "backoffice:read";
export const SCOPE_WRITE = "backoffice:write";
export const SCOPE_UNATTENDED = "backoffice:unattended";

export const SCOPES: { id: string; label: string; detail: string; defaultOn: boolean; required?: boolean }[] = [
  {
    id: SCOPE_READ,
    label: "Read your workspace",
    detail: "View customers, invoices, payments, the receivables summary and the audit log.",
    defaultOn: true,
    required: true
  },
  {
    id: SCOPE_WRITE,
    label: "Make changes, with your confirmation",
    detail:
      "Create customers and draft invoices. Sending or voiding an invoice and recording a payment will ask you to confirm each time.",
    defaultOn: true
  },
  {
    id: SCOPE_UNATTENDED,
    label: "Skip confirmations",
    detail:
      "Let the assistant send or void invoices and record payments without asking you first. Only needed for apps that cannot show confirmation prompts.",
    defaultOn: false
  }
];

export const SCOPE_IDS = SCOPES.map((s) => s.id);
