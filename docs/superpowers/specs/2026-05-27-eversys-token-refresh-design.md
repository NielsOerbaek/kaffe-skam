# Eversys token auto-refresh — design

**Date:** 2026-05-27
**Status:** Approved (design); implementation pending

## Problem

The dashboard authenticates to the Eversys Telemetry API with a single bearer
JWT held in `EVERSYS_TOKEN`. That token is read once at startup
(`config.ts:93`), frozen into each `EversysClient` (`index.ts:21`), and never
updated. Eversys access tokens expire after **7 days** (`expires_in: 604800`).
When the token expires the API returns 401; the current code treats 401 as a
generic `ApiError`, backs off, and retries forever with the dead token — so the
wall display silently goes dark after a week until someone pastes a fresh token
by hand.

We now have proper OAuth client credentials (client ID + secret) plus a
REST-API account, which makes Eversys's documented refresh-token flow (§1.7 of
the Eversys-OAuth-OIDC-Server doc) available. This spec wires automatic,
headless token renewal into the app so it stays authenticated indefinitely.

## Constraints (from the environment)

- **Refresh tokens rotate.** Each successful refresh returns a *new* access
  token *and* a new refresh token, invalidating the previous refresh token.
  Therefore refresh must be **serialized and centrally owned** — there can be
  exactly one in-flight refresh and one source of truth for the current pair.
- **Two machine clients run concurrently** (2. sal + 3. sal). If each refreshed
  independently they would revoke each other's refresh tokens. They must share
  one token owner.
- **The filesystem is read-only except `data/`** at runtime. The systemd unit
  sets `ProtectSystem=strict` with `ReadWritePaths=/opt/kaffe-skam/data`. The
  rotating token pair must be persisted in `data/`, never back into `.env`.
- **Bootstrap is inherently interactive.** The only documented way to obtain the
  first refresh token is the `api-token.php` generator (§1.6), which requires
  client ID + secret *and* the REST-API account email/password. The running app
  cannot mint a first token from client credentials alone.

## Endpoints & token lifecycle (reference)

- Token (refresh) endpoint: `https://auth.eversys-telemetry.com/oauth/token`
- Generator (bootstrap): `https://eversys-telemetry.com/api-token.php`
- API base (unchanged): `https://api.eversys-telemetry.com`, `/v3/...`
- Refresh request (JSON body, per §1.7):
  ```json
  {
    "grant_type": "refresh_token",
    "access_token": "<current bearer>",
    "refresh_token": "<current refresh>",
    "client_id": "<client id>",
    "client_secret": "<client secret>"
  }
  ```
- Refresh response:
  ```json
  {
    "token_type": "Bearer",
    "expires_in": 604800,
    "access_token": "<new bearer>",
    "refresh_token": "<new refresh>"
  }
  ```
  The **new** pair must be used for the next refresh (rotation).

## Architecture (chosen approach)

A single shared `TokenManager` in the long-running process owns the token pair;
`EversysClient` asks it for the current access token per request instead of
holding a frozen string. (Alternatives considered: per-client self-refresh —
rejected, breaks under rotation with 2 clients; external refresher sidecar —
rejected, extra deploy unit for one box.)

### Module: `src/auth.ts` — `TokenManager`

State: `{ accessToken: string; refreshToken: string; expiresAt: number }` where
`expiresAt` is absolute epoch-ms computed as `Date.now() + expires_in * 1000` at
the moment a pair is obtained.

API:

```ts
interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;   // epoch ms
}

interface TokenManagerOpts {
  storePath: string;          // data/eversys-tokens.json
  authUrl: string;            // EVERSYS_AUTH_URL
  clientId: string;
  clientSecret: string;
  fetchFn?: typeof fetch;     // injectable for tests
  now?: () => number;         // injectable clock for tests
  refreshMarginMs?: number;   // default 24h
}

class TokenManager {
  load(): void;                    // read store; throw clear error if absent
  getAccessToken(): string;        // current cached token, no I/O
  refreshOnce(): Promise<void>;    // serialized refresh (shared in-flight promise)
  start(): void;                   // hourly proactive-refresh timer
  stop(): void;
}
```

Behaviour:

- **`load()`** reads `data/eversys-tokens.json`. If the file is missing or
  unparseable, throw an error instructing the operator to run the bootstrap.
  This is the only hard failure at startup related to auth.
- **`getAccessToken()`** returns the in-memory access token synchronously.
- **`refreshOnce()`** POSTs the refresh body to `authUrl`. On success it updates
  in-memory state and persists. It holds a single shared promise: if a refresh
  is already in flight, concurrent callers await the same promise rather than
  issuing a second network call (prevents rotation races).
- **`start()`** runs a timer (hourly) that calls `refreshOnce()` when
  `now() >= expiresAt - refreshMarginMs` (default margin 24 h). With 7-day
  tokens and a polling app this is generous headroom.

### Persistence

`data/eversys-tokens.json`, written **atomically**: write to
`data/eversys-tokens.json.tmp` then `rename()` over the target, file mode
`0600`. `data/` is already gitignored and is the only writable path under the
systemd sandbox.

### Client wiring: `src/api.ts`

`EversysClient` no longer takes `token: string`. It takes an auth provider:

```ts
interface AuthProvider {
  getAccessToken(): string;
  refreshOnce(): Promise<void>;
}
```

`req()`:
- sends `Authorization: Bearer ${auth.getAccessToken()}`;
- on **401**, calls `auth.refreshOnce()` and retries the request **exactly once**;
  a second 401 throws `ApiError(401)` as today;
- **429** keeps the existing `ApiRateLimitError` behaviour;
- other non-OK statuses unchanged.

`TokenManager` satisfies `AuthProvider`, so all clients share one instance.

### Config: `src/config.ts` + `.env`

- New env vars: `EVERSYS_CLIENT_ID`, `EVERSYS_CLIENT_SECRET`, optional
  `EVERSYS_AUTH_URL` (default `https://auth.eversys-telemetry.com/oauth/token`).
- `EVERSYS_TOKEN` becomes **optional/legacy**: the live access token now comes
  from the token store, so `loadConfig` must stop throwing when `EVERSYS_TOKEN`
  is absent (remove the hard requirement at `config.ts:94`). The `Config.token`
  field is **removed**; every consumer (`index.ts:21`, `scripts/backfill.ts`)
  gets its token from the manager / store instead. An `EVERSYS_TOKEN` value, if
  still present in `.env`, is ignored.
- `.env.example` updated to document the new vars and mark `EVERSYS_TOKEN` as
  legacy/unused.

### Startup: `src/index.ts`

1. `loadConfig`.
2. Construct `TokenManager`, `load()` the store (fail fast with the bootstrap
   message if missing), `start()` the proactive timer.
3. Construct each `EversysClient` with the shared manager as its `AuthProvider`.
4. On `SIGTERM`/`SIGINT`, `tokenManager.stop()` alongside the existing
   `server.close()` / `store.close()`.

### Bootstrap (one-time, operator-driven)

Performed via browser automation against `api-token.php`: log in with client
ID + secret + REST-API account credentials, capture `access_token`,
`refresh_token`, `expires_in`, and write the first `data/eversys-tokens.json`
(`expiresAt = now + expires_in*1000`). The account password is used only for
this step and is stored nowhere in the repo, config, or persisted state. This
same procedure is the documented recovery if the app is offline beyond the
refresh-token lifetime and the chain dies.

### `scripts/backfill.ts`

Switch from `cfg.token` to reading the current access token from
`data/eversys-tokens.json`. It is a one-shot historical import; a single valid
token (7-day life) is sufficient, so no refresh logic is added there.

## Failure handling

- **Refresh rejected (400/401 — dead/rotated-away refresh token):** log one
  clear, actionable error ("refresh token rejected — re-run bootstrap"). Do not
  crash-loop; the dashboard keeps serving last-known data from the store.
- **Transient network error on refresh:** swallow and let the next hourly tick
  or the next request's 401 path retry. The existing poller backoff absorbs the
  gap.

## Testing (vitest)

`TokenManager` (fake `fetch` + injected clock + temp store path):
- proactive refresh fires when within the margin of `expiresAt`;
- the new rotated pair is persisted to disk;
- **concurrent `refreshOnce()` calls collapse to a single network request**;
- irrecoverable refresh failure logs the bootstrap message and does not throw
  past the manager.

`EversysClient`:
- 401 → `refreshOnce()` → retry succeeds (one retry only);
- second consecutive 401 throws `ApiError(401)`.

Update the existing `test/api.test.ts` assertion (currently checks a static
`Bearer tok`) to the new `AuthProvider` shape.

## Out of scope

- Changing the OAuth flow itself (we use the documented refresh-token grant).
- Multi-tenant / multi-account tokens.
- Encrypting the token file at rest (file mode `0600` + the systemd sandbox are
  the boundary).
