// Worker secrets. They are set with `npx wrangler secret put <NAME>` in production
// and read from .dev.vars locally, so `wrangler types` cannot see them.
interface __BaseEnv_Env {
  DASH_PASSWORD: string;
  /** base64 of 32 random bytes: openssl rand -base64 32 */
  TOKEN_ENC_KEY: string;
  LI_CLIENT_SECRET?: string;
}
