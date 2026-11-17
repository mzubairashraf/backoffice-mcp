import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

// Bindings and vars come from worker-configuration.d.ts (`wrangler types`).
// This adds what wrangler cannot see: the helper object OAuthProvider injects
// and the production-only GitHub settings.
declare global {
  interface Env {
    OAUTH_PROVIDER: OAuthHelpers;
    /** Secret: HMAC key for confirmation state, at least 32 characters. */
    CONFIRMATION_SECRET: string;
    GITHUB_CLIENT_ID?: string;
    /** Secret. */
    GITHUB_CLIENT_SECRET?: string;
  }
}

export {};
