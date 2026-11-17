/**
 * Error codes are part of the tool contract. An agent can branch on them to
 * decide whether to fix its input, ask the user, or stop.
 */
export type ErrorCode =
  | "invalid_input" // the arguments are wrong; fix the named field
  | "not_found" // the referenced object does not exist in this workspace
  | "invalid_state" // the object exists but its current state forbids this action
  | "idempotency_conflict" // the idempotency key was already used for a different request
  | "permission_denied" // the access token lacks the scope this tool needs
  | "confirmation_declined" // the user said no when asked to confirm
  | "confirmation_unavailable" // the connected app cannot show a confirmation prompt
  | "internal_error";

export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly field?: string
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export const invalid = (field: string, message: string) => new DomainError("invalid_input", message, field);
export const notFound = (what: string, id: string) => new DomainError("not_found", `No ${what} with id ${id}`, "id");
export const invalidState = (message: string) => new DomainError("invalid_state", message);
