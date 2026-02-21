# aws-static-sso

CORS trampoline + client library enabling browser-based AWS SSO (IAM Identity Center) authentication. Users bring their own AWS accounts; no server-side credentials needed.

## Problem

AWS SSO OIDC endpoints (`oidc.{region}.amazonaws.com`) and SSO Portal endpoints (`portal.sso.{region}.amazonaws.com`) don't return CORS headers, making it impossible for static webapps to perform SSO auth flows directly from the browser. This has been a [known issue since 2021][cors-issue] with no resolution from AWS.

Currently, users of browser-based AWS tools must run `aws configure export-credentials --profile <profile> | pbcopy` and paste credentials manually.

## Solution

Two components:

1. **Cloudflare Worker** (~50 lines): stateless CORS proxy restricted to AWS SSO endpoints
2. **Client library** (TypeScript): browser-side PKCE auth flow that talks through the Worker

## Architecture

```
Browser (client lib)              CF Worker                    AWS
  |                                  |                          |
  |-- RegisterClient --------------->|-- oidc.{r}.aws.com ----->|
  |<-- clientId ---------------------|<-- + CORS headers -------|
  |                                  |                          |
  |-- StartDeviceAuthorization ----->|-- oidc.{r}.aws.com ----->|
  |<-- verificationUri, userCode ----|<-- + CORS headers -------|
  |                                  |                          |
  |-- window.open(verificationUri) ------- direct to AWS SSO -->|
  |   (user authenticates at their own SSO portal)              |
  |                                  |                          |
  |-- CreateToken (poll) ----------->|-- oidc.{r}.aws.com ----->|
  |<-- accessToken ------------------|<-- + CORS headers -------|
  |                                  |                          |
  |-- ListAccounts ----------------->|-- portal.sso.{r}.aws --->|
  |<-- accounts, roles --------------|<-- + CORS headers -------|
  |                                  |                          |
  |-- GetRoleCredentials ----------->|-- portal.sso.{r}.aws --->|
  |<-- temp credentials -------------|<-- + CORS headers -------|
  |                                  |                          |
  |-- S3 GetObject (direct, S3 has CORS) ---------------------->|
```

## Worker

### Allowed destinations (allowlist)

Only proxy to these patterns:
- `oidc.{region}.amazonaws.com/*`
- `portal.sso.{region}.amazonaws.com/*`

Reject all other destinations. Validate `{region}` against known AWS region patterns (`us-east-1`, `eu-west-1`, etc.).

### URL scheme

```
https://aws-static-sso.rbw.sh/{destination-host}/{path}
```

Examples:
```
https://aws-static-sso.rbw.sh/oidc.us-east-1.amazonaws.com/client/register
https://aws-static-sso.rbw.sh/portal.sso.us-east-1.amazonaws.com/federation/credentials
```

### Behavior

1. Parse destination host + path from URL
2. Validate against allowlist
3. For `OPTIONS` requests: return 204 with CORS headers (handle preflight)
4. For other methods: forward request to AWS, add CORS headers to response
5. CORS headers to add:
   - `Access-Control-Allow-Origin: *`
   - `Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS`
   - `Access-Control-Allow-Headers: Content-Type, Authorization, x-amz-sso_bearer_token`
   - `Access-Control-Expose-Headers: *`
   - `Access-Control-Max-Age: 86400`

### Rate limiting

Use Cloudflare's built-in rate limiting:
- 100 requests/minute per IP (generous; each auth flow is ~5 requests)
- Return 429 with Retry-After header when exceeded

### Tech stack

- Cloudflare Workers (Wrangler for dev/deploy)
- TypeScript
- No dependencies beyond `@cloudflare/workers-types`

## Client library

### Package

`aws-static-sso` on npm. Zero dependencies (uses browser `fetch` directly).

### API

```ts
import { SSOAuth } from 'aws-static-sso'

const auth = new SSOAuth({
  startUrl: 'https://mycompany.awsapps.com/start',
  region: 'us-east-1',
  // Optional: defaults to 'https://aws-static-sso.rbw.sh'
  // Users can self-host and point here instead
  proxyUrl: 'https://aws-static-sso.rbw.sh',
})

// Step 1: Start auth flow
const deviceAuth = await auth.startAuth()
// { deviceCode, userCode, verificationUri, verificationUriComplete, expiresIn, interval }

// Step 2: Show user the verificationUri + userCode, or open in popup
window.open(deviceAuth.verificationUriComplete)

// Step 3: Poll for completion (user authenticates at their SSO portal)
const token = await auth.pollForToken(deviceAuth)

// Step 4: Get session (also works from localStorage on page reload)
const session = auth.getSession()!

// Step 5: List available accounts
const accounts = await session.listAccounts()
// [{ accountId: '123456789012', accountName: 'Production', emailAddress: '...' }]

// Step 6: List roles for an account (separate call to avoid N+1)
const roles = await session.listAccountRoles('123456789012')
// [{ roleName: 'ReadOnly', accountId: '123456789012' }]

// Step 7: Get credentials for a specific role
const credentials = await session.getCredentials({
  accountId: '123456789012',
  roleName: 'ReadOnly',
})
// { accessKeyId, secretAccessKey, sessionToken, expiration }
```

### Storage

- Store `clientId`/`clientSecret` in localStorage (reuse across sessions until expiry, ~90 days)
- Store `accessToken` in localStorage (reuse until expiry, configurable 1-8hr)
- Store last-used `startUrl` and `region` for convenience

### Credential refresh

- Track expiration times
- Auto-refresh when credentials are within 5 minutes of expiry
- Emit events for credential refresh (so apps can update their SDK clients)

## Project structure

```
aws-oauth/
  worker/
    src/
      index.ts          # CF Worker entry point
    wrangler.toml
    package.json
  client/
    src/
      index.ts          # Client library entry point
      auth.ts           # SSOAuth class
      types.ts          # TypeScript types
    package.json        # published as 'aws-static-sso' on npm
    tsconfig.json
  README.md
```

## Deployment

### Worker

```bash
cd worker
pnpm install
pnpm run dev          # local dev
pnpm run deploy       # deploy to aws-oauth.rbw.sh
```

### Custom domain

Configure `aws-static-sso.rbw.sh` as a custom domain in Cloudflare Workers dashboard (or via wrangler.toml).

## Security considerations

- **Worker never stores anything**: completely stateless, just relays + adds CORS headers
- **Worker never sees SSO passwords**: user authenticates directly at AWS SSO portal
- **Worker does see temporary tokens in transit**: same as any HTTPS-terminating proxy. Tokens are ephemeral (1-8hr). Users who don't trust the public instance can self-host.
- **Restricted destination allowlist**: prevents abuse as a general open proxy
- **Rate limiting**: prevents DDoS amplification
- **Open source**: fully auditable

## Cost estimate

- Cloudflare Workers free tier: 100k requests/day
- Each auth flow: ~5 requests
- Free tier handles ~20k auth sessions/day
- Paid tier ($5/month): 10M requests = ~2M auth sessions/month

## Future ideas

- React hooks package (`use-aws-static-sso`)
- Integration with AWS SDK v3 credential provider interface
- Support for PKCE authorization code flow (in addition to device code flow) if/when AWS supports non-localhost redirect URIs
- Browser extension that eliminates the need for the proxy entirely (extensions can bypass CORS)

[cors-issue]: https://github.com/aws/aws-sdk-js/issues/3651
