/**
 * Sign-in with GitHub, used only to learn who the user is. The GitHub token
 * is used once to read the public profile and is then discarded: it is not
 * stored in the grant and is never available to MCP tools.
 */

export interface GitHubUser {
  id: number;
  login: string;
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export function githubAuthorizeUrl(opts: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  // No scope: the public profile is all that is needed.
  return url.toString();
}

export async function fetchGitHubUser(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  verifier: string;
}): Promise<GitHubUser> {
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code: opts.code,
      redirect_uri: opts.redirectUri,
      code_verifier: opts.verifier
    }),
    signal: AbortSignal.timeout(10_000)
  });
  const token = (await tokenResponse.json()) as { access_token?: string; error?: string };
  if (!tokenResponse.ok || !token.access_token) {
    throw new Error(`GitHub token exchange failed: ${token.error ?? tokenResponse.status}`);
  }

  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "backoffice-mcp"
    },
    signal: AbortSignal.timeout(10_000)
  });
  if (!userResponse.ok) throw new Error(`GitHub user lookup failed: ${userResponse.status}`);
  const user = (await userResponse.json()) as { id?: number; login?: string };
  if (typeof user.id !== "number" || typeof user.login !== "string") {
    throw new Error("GitHub returned an unexpected user profile");
  }
  return { id: user.id, login: user.login };
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
