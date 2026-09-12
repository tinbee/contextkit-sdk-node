import { codeChallenge, generateCodeVerifier, generateState } from "../pkce.js";

describe("pkce", () => {
  it("matches the RFC 7636 appendix B vector", () => {
    expect(codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("generates verifiers inside the API's 43–128 window, base64url only", () => {
    for (let i = 0; i < 20; i++) {
      const v = generateCodeVerifier();
      expect(v.length).toBeGreaterThanOrEqual(43);
      expect(v.length).toBeLessThanOrEqual(128);
      expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("generates distinct states", () => {
    expect(generateState()).not.toBe(generateState());
  });
});
