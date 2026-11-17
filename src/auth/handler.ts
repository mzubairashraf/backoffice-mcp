import { AuthorizationError, CimdFetchError, authorizationErrorRedirect } from "@cloudflare/workers-oauth-provider";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";

import type { AuthProps } from "../mcp/server";
import { fetchGitHubUser, githubAuthorizeUrl, pkcePair } from "./github";
import { consentPage, homePage, messagePage } from "./pages";
import { SCOPE_IDS, SCOPE_READ } from "./scopes";

/**
 * Everything that is not the MCP endpoint or a token endpoint: the home
 * page, the consent page and the GitHub callback.
 *
 * The order in the flow matters. The user approves this specific MCP client
 * first, and only then is sent to GitHub. Without that, any client could
 * ride on an approval the user once gave GitHub for a different client (the
 * "confused deputy" problem in the MCP security guidance).
 */
const app = new Hono<{ Bindings: Env }>();

const html = (body: string, status = 200, headers?: Headers) => {
  const h = headers ?? new Headers();
  h.set("Content-Type", "text/html; charset=utf-8");
  h.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://github.com; frame-ancestors 'none'");
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Content-Type-Options", "nosniff");
  return new Response(body, { status, headers: h });
};

app.get("/", (c) => html(homePage(c.env.MCP_RESOURCE)));

app.get("/authorize", async (c) => {
  try {
    const oauth = c.env.OAUTH_PROVIDER;
    const request = await oauth.parseAuthRequest(c.req.raw);
    const details = await oauth.describeConsent(request);
    const consent = await oauth.beginConsent(request);
    return html(consentPage(details, consent.handle, c.env.AUTH_MODE), 200, consent.headers);
  } catch (error) {
    return authError(error);
  }
});

app.post("/authorize", async (c) => {
  try {
    const oauth = c.env.OAUTH_PROVIDER;
    const form = await c.req.formData();
    const handle = String(form.get("handle") ?? "");

    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(c.req.raw, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }

    // Only scopes this server defines, and read access is always part of a grant.
    const ticked = form.getAll("scope").map(String).filter((s) => SCOPE_IDS.includes(s));
    const scope = Array.from(new Set([SCOPE_READ, ...ticked]));
    const approved = await oauth.approveConsent(c.req.raw, handle, { scope });

    if (c.env.AUTH_MODE === "demo") {
      const name = String(form.get("demo_user") ?? "");
      if (!/^[a-z0-9-]{1,32}$/.test(name)) {
        return html(messagePage("Invalid workspace name", "Use 1 to 32 lower-case letters, digits or hyphens."), 400);
      }
      return finish(c.env, approved.request, { userId: `demo-${name}`, login: name }, approved.headers);
    }

    const { clientId } = githubConfig(c.env);
    const { verifier, challenge } = await pkcePair();
    const upstream = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
    upstream.headers.set(
      "Location",
      githubAuthorizeUrl({ clientId, redirectUri: callbackUrl(c.env), state: upstream.state, challenge })
    );
    return new Response(null, { status: 302, headers: upstream.headers });
  } catch (error) {
    return authError(error);
  }
});

app.get("/callback", async (c) => {
  try {
    const oauth = c.env.OAUTH_PROVIDER;
    const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(c.req.raw);
    const params = new URL(c.req.url).searchParams;
    const code = params.get("code");

    if (params.get("error") || !code) {
      headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
      return new Response(null, { status: 302, headers });
    }

    const { clientId, clientSecret } = githubConfig(c.env);
    const user = await fetchGitHubUser({ clientId, clientSecret, code, redirectUri: callbackUrl(c.env), verifier: data.verifier });
    return finish(c.env, original, { userId: `github-${user.id}`, login: user.login }, headers);
  } catch (error) {
    return authError(error);
  }
});

app.notFound(() => html(messagePage("Not found", "There is nothing at this address."), 404));

/** Creates the grant and sends the user back to the MCP client. */
async function finish(env: Env, request: AuthRequest, user: { userId: string; login: string }, headers: Headers): Promise<Response> {
  const props: AuthProps = { userId: user.userId, login: user.login, scopes: request.scope };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request,
    userId: user.userId,
    metadata: { login: user.login },
    scope: request.scope,
    props
  });
  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
}

function githubConfig(env: Env): { clientId: string; clientSecret: string } {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    throw new Error("AUTH_MODE is github but GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET is not set");
  }
  return { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
}

function callbackUrl(env: Env): string {
  return new URL("/callback", env.MCP_RESOURCE).toString();
}

/**
 * A redirect back to the client is only safe once the library has validated
 * the client and its redirect URI; it says so by providing redirectTo.
 * Anything else is shown here and never redirected.
 */
function authError(error: unknown): Response {
  if (error instanceof AuthorizationError && error.redirectTo) {
    return Response.redirect(error.redirectTo, 302);
  }
  if (error instanceof AuthorizationError) {
    return html(messagePage("This sign-in link is no longer valid", `${error.description ?? "The request could not be verified."} Start connecting again from your app.`), 400);
  }
  if (error instanceof CimdFetchError) {
    return html(messagePage("This app could not be verified", "Its published details could not be read. Try again later."), 400);
  }
  console.error(JSON.stringify({ msg: "authorization failed", error: String(error) }));
  return html(messagePage("Sign-in failed", "Something went wrong while signing you in. Start connecting again from your app."), 500);
}

export { app as AuthHandler };
