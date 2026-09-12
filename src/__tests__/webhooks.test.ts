import { WebhookVerificationError } from "../errors.js";
import { isConnectionEvent, isRuleEvent } from "../types.js";
import { InMemoryReplayGuard, signWebhook, verifyWebhook } from "../webhooks.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const NOW = Date.parse("2026-09-12T12:00:00.000Z");
const ruleBody = JSON.stringify({
  event_id: "e1",
  rule_id: "r1",
  grant_id: "g1",
  type: "zone.enter",
  occurred_at: "2026-09-12T11:59:50.000Z",
  target: { label: "Hotel" },
});

describe("verifyWebhook", () => {
  it("accepts a fresh, correctly signed delivery and parses the event", async () => {
    const event = await verifyWebhook({
      rawBody: Buffer.from(ruleBody),
      signature: signWebhook(ruleBody, SECRET, NOW),
      secret: SECRET,
      now: NOW,
    });
    expect(isRuleEvent(event)).toBe(true);
    expect(isConnectionEvent(event)).toBe(false);
    expect(event.event_id).toBe("e1");
  });

  it("accepts the header as an array (Node's IncomingHttpHeaders shape)", async () => {
    await expect(
      verifyWebhook({
        rawBody: ruleBody,
        signature: [signWebhook(ruleBody, SECRET, NOW)],
        secret: SECRET,
        now: NOW,
      }),
    ).resolves.toBeDefined();
  });

  it("rejects a tampered body", async () => {
    const tampered = ruleBody.replace("Hotel", "Bank");
    await expect(
      verifyWebhook({
        rawBody: tampered,
        signature: signWebhook(ruleBody, SECRET, NOW),
        secret: SECRET,
        now: NOW,
      }),
    ).rejects.toThrow(/tampered/);
  });

  it("rejects the wrong secret", async () => {
    await expect(
      verifyWebhook({
        rawBody: ruleBody,
        signature: signWebhook(ruleBody, "other", NOW),
        secret: SECRET,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it("rejects stale and future timestamps beyond the tolerance, in both directions", async () => {
    for (const offsetS of [61, -61]) {
      await expect(
        verifyWebhook({
          rawBody: ruleBody,
          signature: signWebhook(ruleBody, SECRET, NOW - offsetS * 1000),
          secret: SECRET,
          now: NOW,
        }),
      ).rejects.toThrow(/tolerance/);
    }
    await expect(
      verifyWebhook({
        rawBody: ruleBody,
        signature: signWebhook(ruleBody, SECRET, NOW - 59_000),
        secret: SECRET,
        now: NOW,
      }),
    ).resolves.toBeDefined();
  });

  it("caps the tolerance at the API's maximum", async () => {
    await expect(
      verifyWebhook({
        rawBody: ruleBody,
        signature: signWebhook(ruleBody, SECRET, NOW - 400_000),
        secret: SECRET,
        now: NOW,
        toleranceS: 10_000,
      }),
    ).rejects.toThrow(/300s/);
  });

  it("rejects a missing or malformed header", async () => {
    await expect(
      verifyWebhook({ rawBody: ruleBody, signature: undefined, secret: SECRET }),
    ).rejects.toThrow(/missing/);
    await expect(
      verifyWebhook({ rawBody: ruleBody, signature: "garbage", secret: SECRET }),
    ).rejects.toThrow(/malformed/);
  });

  it("ignores unknown header keys so a v2 rollout does not break v1 receivers", async () => {
    const header = `${signWebhook(ruleBody, SECRET, NOW)},v2=deadbeef`;
    await expect(
      verifyWebhook({ rawBody: ruleBody, signature: header, secret: SECRET, now: NOW }),
    ).resolves.toBeDefined();
  });

  it("rejects a replayed event when a guard is supplied", async () => {
    const replayGuard = new InMemoryReplayGuard();
    const params = {
      rawBody: ruleBody,
      signature: signWebhook(ruleBody, SECRET, NOW),
      secret: SECRET,
      now: NOW,
      replayGuard,
    };
    await expect(verifyWebhook(params)).resolves.toBeDefined();
    await expect(verifyWebhook(params)).rejects.toThrow(/already processed/);
  });

  it("rejects a valid signature over a body that is not an event", async () => {
    const body = JSON.stringify({ hello: "world" });
    await expect(
      verifyWebhook({
        rawBody: body,
        signature: signWebhook(body, SECRET, NOW),
        secret: SECRET,
        now: NOW,
      }),
    ).rejects.toThrow(/not a ContextKit event/);
  });
});
