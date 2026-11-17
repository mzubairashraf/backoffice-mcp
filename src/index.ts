import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { env } from "cloudflare:workers";

import { AuthHandler } from "./auth/handler";
import { SCOPE_IDS } from "./auth/scopes";
import { createServer } from "./mcp/server";

/**
 * One Worker plays both OAuth roles: it is the authorization server (it
 * issues tokens after the consent page) and the resource server (the MCP
 * endpoint that accepts them). The MCP handler is stateless: a fresh server
 * is built for each request, and all state is in D1 and KV.
 */
const mcpHandler = createMcpHandler(() => createServer({ db: env.DB, confirmationSecret: env.CONFIRMATION_SECRET }));

const oauthProvider = new OAuthProvider<Env>({
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  // Two ways for a client to identify itself: a Client ID Metadata Document
  // (preferred by the 2026-07-28 MCP spec) and dynamic registration, kept
  // for clients that do not support the former yet.
  clientIdMetadataDocumentEnabled: true,
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: SCOPE_IDS,

  apiRoute: "/mcp",
  apiHandler: {
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
      return mcpHandler(request, env, ctx);
    }
  },
  defaultHandler: {
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
      return AuthHandler.fetch(request, env, ctx);
    }
  },

  // Tokens are bound to this URL and are rejected anywhere else.
  resourceMetadata: { resource: env.MCP_RESOURCE, resource_name: "Invoicing Back Office" },

  accessTokenTTL: 3600,
  refreshTokenTTL: 30 * 24 * 3600
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // A deploy that still points MCP_RESOURCE at localhost would fail every
    // request with an opaque audience error. Say what is wrong instead.
    const origin = new URL(request.url).origin;
    if (origin !== new URL(env.MCP_RESOURCE).origin) {
      return new Response(`MCP_RESOURCE is ${env.MCP_RESOURCE}, but this Worker is served from ${origin}. Set MCP_RESOURCE to ${origin}/mcp and deploy again.`, {
        status: 500
      });
    }
    if (env.AUTH_MODE === "demo" && !["localhost", "127.0.0.1"].includes(new URL(request.url).hostname)) {
      return new Response("AUTH_MODE=demo has no real sign-in and only runs on localhost. Set AUTH_MODE=github for a deployment.", { status: 500 });
    }
    return oauthProvider.fetch(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
