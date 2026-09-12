# contextkit-sdk

Node.js SDK for [ContextKit](https://contextkit.com). Ask scoped questions about a
connected user's location — "are they inside this zone right now?" — without ever
holding their coordinates.

Full documentation lives at **[docs.contextkit.com](https://docs.contextkit.com)**.
This README covers only the connect flow.

```sh
pnpm add contextkit-sdk
```

Node 20+. Server-side only: the client secret must never reach a browser.

## Connect a user

ContextKit uses OAuth 2 with PKCE. Three steps, all on your backend.

**1. Send the user to consent.** Keep `state` and the verifier in the user's session.

```ts
import { ContextKit, generateCodeVerifier, generateState } from "contextkit-sdk";

const ck = new ContextKit({
  clientId: process.env.CONTEXTKIT_CLIENT_ID!,
  clientSecret: process.env.CONTEXTKIT_CLIENT_SECRET!,
});

const state = generateState();
const codeVerifier = generateCodeVerifier();
session.contextkit = { state, codeVerifier };

redirect(
  ck.authorizeUrl({
    redirectUri: "https://yourapp.example/contextkit/callback",
    scopes: ["location.verify.zone", "location.place.current"],
    state,
    codeVerifier,
    externalUserId: user.id, // optional; shown to you, never to the user
  }),
);
```

**2. Handle the callback.** Refuse it if `state` does not match, then exchange the code.

```ts
if (query.state !== session.contextkit.state) throw new Error("state mismatch");

const tokens = await ck.exchangeCode({
  code: query.code,
  codeVerifier: session.contextkit.codeVerifier,
  redirectUri: "https://yourapp.example/contextkit/callback",
});

await db.users.update(user.id, { contextkit: tokens }); // persist the whole set
```

**3. Ask questions.** Refresh tokens rotate, so persist whatever `onTokens` hands you.

```ts
const stored = await db.users.get(user.id).contextkit;

const ckUser = ck.forUser(stored, {
  onTokens: (next) => db.users.update(user.id, { contextkit: next }),
});

const answer = await ckUser.answers.verifyZone({
  lat: 48.3537,
  lon: 11.7861,
  radiusM: 500,
  label: "Munich Airport arrivals",
});
// answer.state is "inside" | "outside" | "unknown" — unknown is a value, not an error
```

## Errors

Every failure is a `ContextKitError`; the subclass says what to do.

| Error                          | Meaning                                             | Do                       |
| ------------------------------ | --------------------------------------------------- | ------------------------ |
| `TokenRevokedError`            | The grant is gone (revoked, expired, replayed).     | Send the user to step 1. |
| `RateLimitedError`             | Per-app budget or rate limit. `retryAfterSeconds`.  | Wait, then retry.        |
| `ScopeError`                   | The grant lacks the scope this call needs.          | Request it at step 1.    |
| `NotFoundError`                | Unshared and nonexistent look identical on purpose. | Refresh your place list. |
| `ValidationError`              | Request shape was wrong. `messages` says how.       | Fix the call.            |
| `TimeoutError`, `NetworkError` | Transient.                                          | Retry with backoff.      |

## Webhooks

Rules and subscriptions deliver signed POSTs. Verify with the **raw** body bytes.

```ts
import { verifyWebhook, isRuleEvent } from "contextkit-sdk";

app.post("/hooks/contextkit", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = await verifyWebhook({
      rawBody: req.body,
      signature: req.headers["x-contextkit-signature"],
      secret: process.env.CONTEXTKIT_WEBHOOK_SECRET!,
    });
  } catch {
    return res.status(400).end();
  }
  if (isRuleEvent(event)) queue.enqueue(event);
  res.status(204).end();
});
```

## Development

```sh
pnpm install
pnpm typecheck && pnpm test && pnpm build
```

Releases publish to npm on a `v*` tag that matches `package.json`.
