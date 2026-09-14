# @tinbee/contextkit-sdk

Node.js SDK for [ContextKit](https://contextkit.com). Ask scoped questions about a
connected user's location — "are they inside this zone right now?" — without ever
holding their coordinates.

Full documentation lives at **[docs.contextkit.com](https://docs.contextkit.com)**.
This README covers the connect flow and the essentials around it.

```sh
pnpm add @tinbee/contextkit-sdk
```

Node 20+. Server-side only: the client secret must never reach a browser.

## Connect a user

ContextKit uses OAuth 2 with PKCE. Three steps, all on your backend.

**1. Send the user to consent.** Keep `state` and the verifier in the user's session.

```ts
import { ContextKit, generateCodeVerifier, generateState } from "@tinbee/contextkit-sdk";

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

## Rules with a window

A rule tied to a date should say so. Outside its window it is not evaluated,
and it counts against the ten-rules-per-connection cap only while the window
is open, so an itinerary's worth of one-day windows fits in a single slot.

```ts
const checkIn = new Date("2026-09-20T14:00:00Z");
const HOUR = 3_600_000;

await ckUser.rules.createZone({
  type: "enter",
  lat: 41.9028,
  lon: 12.4964,
  radiusM: 300,
  label: "Hotel Artemide",
  activeFrom: new Date(checkIn.getTime() - 24 * HOUR), // a Date or an ISO 8601 string
  activeUntil: new Date(checkIn.getTime() + 12 * HOUR),
  webhookUrl: "https://yourapp.example/hooks/contextkit",
});
```

## Disconnect a user

When a user disconnects ContextKit inside your product, end the connection on
ContextKit too. This revokes the whole grant — every token, every rule — and the
handle then refuses further calls with `TokenRevokedError`.

```ts
await ckUser.disconnect();
await db.users.update(user.id, { contextkit: null });
```

If all you have left is a stored token, `ck.revokeToken(token)` does the same
without a handle. Either kind of token works, and revoking one that is already
dead is a success, not an error.

## Purposes

Every read of raw coordinates — `locations.latest`, `at`, `range` and `days` —
must name a **purpose**: the key of a purpose you registered for your app in the
developer portal. It is required; the SDK refuses a call without one.

```ts
const { point } = await ckUser.locations.latest({ purpose: "arrival_check" });
```

Each purpose is a key (`^[a-z][a-z0-9_]{2,39}$`), a one-sentence description,
the sensitive scopes it may use and how many calls a day you expect. ContextKit
reviews it before a production app can use it, and the API answers
`ValidationError` (`error: "invalid_purpose"`, with a `detail`) for a purpose
that is unknown, unapproved, or not allowed for that scope.

Purposes are how end users decide whether to trust your app. They see your
descriptions, verbatim, on the consent screen, next to every access in their
access log, and again when they renew. Write them for that reader: say what
you do with the location and why, in words they would recognise.

## When sensitive access ends

Raw-coordinate scopes (`location.latest.read`, `location.history.read`,
`location.lookup`) expire on their own clock — 1 to 90 days, chosen by the user —
while the rest of the connection keeps working. `tokens.sensitiveScopesExpiresAt`
(epoch ms) and `ckUser.me()` tell you when.

- **Listen for `sensitive.expiring`.** Subscribe to it and it arrives once 14
  days and once 7 days before the end (`days_left`). Offer renewal by sending
  the user through consent with the same scopes.
- **Handle `ScopeExpiredError`.** A sensitive call after the end raises it (it
  is a `ScopeError`). Show that access to their location has ended and offer
  to renew through consent. Until `renewalGraceEndsAt` renewal is one tap; after
  it the scopes are removed (`sensitive.removed`) and it is a fresh request.
  Do not retry the call.
- **Keep it quiet.** Show at most one non-blocking notice per event, as the
  Acceptable Use Policy requires. Never gate the rest of your product on it.

```ts
import { ScopeExpiredError, isSensitiveExpiringEvent } from "@tinbee/contextkit-sdk";

try {
  await ckUser.locations.latest({ purpose: "arrival_check" });
} catch (err) {
  if (err instanceof ScopeExpiredError) return showRenewNotice(err.renewalGraceEndsAt);
  throw err;
}

if (isSensitiveExpiringEvent(event)) notifyOnce(event.grant_id, event.days_left);
```

## Errors

Every failure is a `ContextKitError`; the subclass says what to do.

| Error                          | Meaning                                                 | Do                           |
| ------------------------------ | ------------------------------------------------------- | ---------------------------- |
| `TokenRevokedError`            | The grant is gone (revoked, expired, replayed).         | Send the user to step 1.     |
| `RateLimitedError`             | Per-app budget or rate limit. `retryAfterSeconds`.      | Wait, then retry.            |
| `ScopeExpiredError`            | The sensitive tier lapsed; the rest still works.        | Say it ended; renew, step 1. |
| `ScopeError`                   | The grant lacks the scope this call needs.              | Request it at step 1.        |
| `NotFoundError`                | Unshared and nonexistent look identical on purpose.     | Refresh your place list.     |
| `ValidationError`              | Request shape was wrong. `messages` / `detail` say how. | Fix the call.                |
| `TimeoutError`, `NetworkError` | Transient.                                              | Retry with backoff.          |

## Webhooks

Rules and subscriptions deliver signed POSTs. Verify with the **raw** body bytes.

```ts
import { verifyWebhook, isRuleEvent } from "@tinbee/contextkit-sdk";

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

## License

Apache-2.0. See [LICENSE](LICENSE).

## Development

```sh
pnpm install
pnpm typecheck && pnpm test && pnpm build
```

Releases publish to npm on a `v*` tag that matches `package.json`.
