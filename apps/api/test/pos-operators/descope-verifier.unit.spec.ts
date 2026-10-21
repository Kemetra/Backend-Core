/**
 * descope-verifier.unit.spec.ts — RT-791 Descope session-JWT verifier.
 *
 * Docker-free and offline: every token is signed with a key generated in the
 * test, and the JWKS is either a local key set or a local HTTP server, so no
 * request reaches Descope. Proves the verifier refuses (throws a generic error)
 * on bad signature, wrong issuer, expired / exp-less tokens, a disallowed
 * algorithm, a JWKS fetch failure, a missing `sub` and (when configured) a
 * wrong audience; a valid token returns `{ sub }` only.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  SignJWT,
  createLocalJWKSet,
  createRemoteJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type KeyLike,
} from "jose";

import {
  DescopeJwksVerifier,
  acceptedDescopeIssuers,
  descopeIssuer,
  descopeJwksUrl,
} from "../../src/pos-operators/descope-verifier";

const PROJECT_ID = "P2testProject0001";
const ISSUER = descopeIssuer(PROJECT_ID);
const SUB = "U2descopeUser0001";
const KID = "test-kid-1";

let privateKey: KeyLike;
let publicJwk: JWK;
let otherPrivateKey: KeyLike;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  otherPrivateKey = (await generateKeyPair("RS256")).privateKey;
});

interface TokenOptions {
  readonly key?: KeyLike;
  readonly alg?: string;
  readonly kid?: string;
  readonly issuer?: string;
  readonly sub?: string | null;
  readonly audience?: string;
  readonly expiresIn?: string | number | null;
  readonly drn?: string;
}

async function token(opts: TokenOptions = {}): Promise<string> {
  let jwt = new SignJWT({ drn: opts.drn ?? "DS" })
    .setProtectedHeader({ alg: opts.alg ?? "RS256", kid: opts.kid ?? KID })
    .setIssuedAt()
    .setIssuer(opts.issuer ?? ISSUER);
  if (opts.sub !== null) jwt = jwt.setSubject(opts.sub ?? SUB);
  if (opts.audience !== undefined) jwt = jwt.setAudience(opts.audience);
  if (opts.expiresIn !== null) jwt = jwt.setExpirationTime(opts.expiresIn ?? "5m");
  return jwt.sign(opts.key ?? privateKey);
}

function localVerifier(audience?: string): DescopeJwksVerifier {
  return new DescopeJwksVerifier({
    issuer: ISSUER,
    jwks: createLocalJWKSet({ keys: [publicJwk] }),
    ...(audience !== undefined ? { audience } : {}),
  });
}

describe("descopeIssuer / descopeJwksUrl", () => {
  it("derives the issuer and the JWKS URL from the project id", () => {
    expect(descopeIssuer(PROJECT_ID)).toBe(`https://api.descope.com/${PROJECT_ID}`);
    expect(descopeJwksUrl(PROJECT_ID)).toBe(
      `https://api.descope.com/${PROJECT_ID}/.well-known/jwks.json`,
    );
  });

  it.each(["", "P2/../evil", "P2 x", "https://evil.example", "P2?x=1"])(
    "refuses a malformed project id %p",
    (bad) => {
      expect(() => descopeIssuer(bad)).toThrow(/DESCOPE_PROJECT_ID/);
    },
  );
});

describe("DescopeJwksVerifier — accepts", () => {
  it("returns only { sub } for a valid token", async () => {
    await expect(localVerifier().verify(await token())).resolves.toEqual({ sub: SUB });
  });

  it("checks aud when an audience is configured", async () => {
    const t = await token({ audience: PROJECT_ID });
    await expect(localVerifier(PROJECT_ID).verify(t)).resolves.toEqual({ sub: SUB });
  });

  it("accepts either listed issuer form (URL or bare project id)", async () => {
    const verifier = new DescopeJwksVerifier({
      issuer: acceptedDescopeIssuers(PROJECT_ID),
      jwks: createLocalJWKSet({ keys: [publicJwk] }),
    });
    await expect(verifier.verify(await token({ issuer: PROJECT_ID }))).resolves.toEqual({ sub: SUB });
    await expect(verifier.verify(await token())).resolves.toEqual({ sub: SUB });
    await expect(verifier.verify(await token({ issuer: "P2other" }))).rejects.toThrow(
      "descope verifier: token rejected",
    );
  });

  it("DESCOPE_JWT_ISSUER replaces both default issuer forms", () => {
    process.env["DESCOPE_JWT_ISSUER"] = "https://issuer.override.example";
    try {
      expect(acceptedDescopeIssuers(PROJECT_ID)).toEqual(["https://issuer.override.example"]);
    } finally {
      delete process.env["DESCOPE_JWT_ISSUER"];
    }
    expect(acceptedDescopeIssuers(PROJECT_ID)).toEqual([ISSUER, PROJECT_ID]);
  });

  it("ignores aud when no audience is configured", async () => {
    const t = await token({ audience: "anything" });
    await expect(localVerifier().verify(t)).resolves.toEqual({ sub: SUB });
  });
});

describe("DescopeJwksVerifier — refuses", () => {
  const cases: Array<[string, () => Promise<string>, string | undefined]> = [
    ["a bad signature (signed by another key)", () => token({ key: otherPrivateKey }), undefined],
    ["a wrong issuer", () => token({ issuer: "https://api.descope.com/P2other" }), undefined],
    ["an expired token", () => token({ expiresIn: Math.floor(Date.now() / 1000) - 600 }), undefined],
    ["a token without exp", () => token({ expiresIn: null }), undefined],
    ["a missing sub", () => token({ sub: null }), undefined],
    ["an empty sub", () => token({ sub: "" }), undefined],
    ["a wrong audience", () => token({ audience: "other-aud" }), PROJECT_ID],
    ["a missing audience when one is configured", () => token(), PROJECT_ID],
    ["a Descope refresh token (drn=DSR)", () => token({ drn: "DSR" }), undefined],
  ];

  it.each(cases)("%s", async (_label, make, audience) => {
    await expect(localVerifier(audience).verify(await make())).rejects.toThrow(
      "descope verifier: token rejected",
    );
  });

  it("a disallowed algorithm (ES256 key published in the JWKS)", async () => {
    const ec = await generateKeyPair("ES256");
    const ecJwk = { ...(await exportJWK(ec.publicKey)), kid: "ec-kid", alg: "ES256" };
    const verifier = new DescopeJwksVerifier({
      issuer: ISSUER,
      jwks: createLocalJWKSet({ keys: [publicJwk, ecJwk] }),
    });
    const t = await token({ key: ec.privateKey, alg: "ES256", kid: "ec-kid" });
    await expect(verifier.verify(t)).rejects.toThrow("descope verifier: token rejected");
  });

  it("an unsigned (alg=none) token", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", kid: KID })).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({ sub: SUB, iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 300 }),
    ).toString("base64url");
    await expect(localVerifier().verify(`${header}.${body}.`)).rejects.toThrow(
      "descope verifier: token rejected",
    );
  });

  it("garbage input", async () => {
    await expect(localVerifier().verify("not-a-jwt")).rejects.toThrow(
      "descope verifier: token rejected",
    );
  });

  it("a JWKS getter that throws", async () => {
    const verifier = new DescopeJwksVerifier({
      issuer: ISSUER,
      jwks: async () => {
        throw new Error("network down");
      },
    });
    await expect(verifier.verify(await token())).rejects.toThrow(
      "descope verifier: token rejected",
    );
  });

  it("never carries the claims, the token or the cause on the thrown error", async () => {
    const t = await token({ issuer: "https://api.descope.com/P2other" });
    const err = await localVerifier()
      .verify(t)
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const e = err as Error & { cause?: unknown; payload?: unknown };
    expect(e.cause).toBeUndefined();
    expect(e.payload).toBeUndefined();
    const serialized = JSON.stringify({ ...e, message: e.message, stack: e.stack });
    expect(serialized).not.toContain(SUB);
    expect(serialized).not.toContain(t);
    // Only jose's fixed error code is kept, for outage-vs-forgery triage.
    expect(e.message).toBe("descope verifier: token rejected (ERR_JWT_CLAIM_VALIDATION_FAILED)");
  });

  it("keeps a JWKS outage distinguishable by code only", async () => {
    const outage = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1"), { code: "ERR_JWKS_TIMEOUT" });
    const verifier = new DescopeJwksVerifier({
      issuer: ISSUER,
      jwks: async () => {
        throw outage;
      },
    });
    await expect(verifier.verify(await token())).rejects.toThrow(
      /^descope verifier: token rejected \(ERR_JWKS_TIMEOUT\)$/,
    );
  });
});

describe("DescopeJwksVerifier — remote JWKS over HTTP (local server)", () => {
  let server: Server;
  let baseUrl: string;
  let failing = false;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      if (failing) {
        res.writeHead(500).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [publicJwk] }));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks.json`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  it("verifies against a fetched JWKS", async () => {
    failing = false;
    const verifier = new DescopeJwksVerifier({
      issuer: ISSUER,
      jwks: createRemoteJWKSet(new URL(baseUrl)),
    });
    await expect(verifier.verify(await token())).resolves.toEqual({ sub: SUB });
  });

  it("refuses when the JWKS fetch fails", async () => {
    failing = true;
    const verifier = new DescopeJwksVerifier({
      issuer: ISSUER,
      jwks: createRemoteJWKSet(new URL(baseUrl)),
    });
    await expect(verifier.verify(await token())).rejects.toThrow(
      "descope verifier: token rejected",
    );
  });
});
