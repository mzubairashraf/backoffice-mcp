import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside the Workers runtime (workerd) with real D1 and KV
// bindings provided by Miniflare, so SQL, transactions and the OAuth
// provider behave as they do when deployed.
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("migrations"),
          CONFIRMATION_SECRET: "test-only-confirmation-secret-0123456789abcdef"
        }
      }
    })
  ],
  test: { setupFiles: ["./test/setup.ts"] }
}));
