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
  descopeVerifierConfig,
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
    // The form real Descope session JWTs carry (rt9 lab, 2026-10-21).
    expect(descopeIssuer(PROJECT_ID)).toBe(`https://api.descope.com/v1/apps/${PROJECT_ID}`);
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
  it("returns only { providerKey, sub } for a valid token", async () => {
    await expect(localVerifier().verify(await token())).resolves.toEqual({ providerKey: "descope", sub: SUB });
  });

  it("checks aud when an audience is configured", async () => {
    const t = await token({ audience: PROJECT_ID });
    await expect(localVerifier(PROJECT_ID).verify(t)).resolves.toEqual({ providerKey: "descope", sub: SUB });
  });

  it("accepts every listed issuer form (v1/apps URL, legacy URL, bare project id)", async () => {
    const verifier = new DescopeJwksVerifier({
      issuer: acceptedDescopeIssuers(PROJECT_ID),
      jwks: createLocalJWKSet({ keys: [publicJwk] }),
    });
    await expect(verifier.verify(await token({ issuer: PROJECT_ID }))).resolves.toEqual({ providerKey: "descope", sub: SUB });
    await expect(
      verifier.verify(await token({ issuer: `https://api.descope.com/${PROJECT_ID}` })),
    ).resolves.toEqual({ providerKey: "descope", sub: SUB });
    await expect(verifier.verify(await token())).resolves.toEqual({ providerKey: "descope", sub: SUB });
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
    expect(acceptedDescopeIssuers(PROJECT_ID)).toEqual([
      ISSUER,
      `https://api.descope.com/${PROJECT_ID}`,
      PROJECT_ID,
    ]);
  });

  it("ignores aud when no audience is configured", async () => {
    const t = await token({ audience: "anything" });
    await expect(localVerifier().verify(t)).resolves.toEqual({ providerKey: "descope", sub: SUB });
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

  // A fresh remote key set per case: jose caches a fetched JWKS.
  it.each<[string, boolean, (p: Promise<unknown>) => Promise<unknown>]>([
    ["verifies against a fetched JWKS", false, (p) => expect(p).resolves.toEqual({ providerKey: "descope", sub: SUB })],
    ["refuses when the JWKS fetch fails", true, (p) => expect(p).rejects.toThrow("descope verifier: token rejected")],
  ])("%s", async (_label, fetchFails, check) => {
    failing = fetchFails;
    const verifier = new DescopeJwksVerifier({ issuer: ISSUER, jwks: createRemoteJWKSet(new URL(baseUrl)) });
    await check(verifier.verify(await token()));
  });
});

// ---------------------------------------------------------------------------
// RT-791 lab finding: a real Descope session JWT (rt9 lab, shape only) carries
// iss = https://api.descope.com/v1/apps/<projectId>, aud = <projectId>,
// drn = DS, a 600 s lifetime, no nbf, and amr / email / rexp claims.
// ---------------------------------------------------------------------------

describe("descopeVerifierConfig — the real Descope session token shape", () => {
  const KEYS = ["DESCOPE_JWT_ISSUER", "DESCOPE_JWT_AUDIENCE"];
  afterEach(() => {
    for (const k of KEYS) delete process.env[k];
  });

  async function realShapeToken(overrides: { aud?: string | null; iss?: string } = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    let jwt = new SignJWT({
      amr: ["pwd"],
      drn: "DS",
      email: "manager@example.test",
      rexp: new Date((now + 2_419_200) * 1000).toISOString(),
    })
      .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: KID })
      .setIssuer(overrides.iss ?? `https://api.descope.com/v1/apps/${PROJECT_ID}`)
      .setSubject(SUB)
      .setIssuedAt(now)
      .setExpirationTime(now + 600);
    if (overrides.aud !== null) jwt = jwt.setAudience(overrides.aud ?? PROJECT_ID);
    return jwt.sign(privateKey);
  }

  function configuredVerifier(): DescopeJwksVerifier {
    return new DescopeJwksVerifier({
      ...descopeVerifierConfig(PROJECT_ID),
      jwks: createLocalJWKSet({ keys: [publicJwk] }),
    });
  }

  it("accepts the lab token shape with no env overrides", async () => {
    await expect(configuredVerifier().verify(await realShapeToken())).resolves.toEqual({ providerKey: "descope", sub: SUB });
  });

  it("defaults the audience to the project id", () => {
    expect(descopeVerifierConfig(PROJECT_ID).audience).toBe(PROJECT_ID);
  });

  it.each<[string, { aud?: string | null; iss?: string }]>([
    ["another project's audience", { aud: "P2otherProject" }],
    ["no audience at all", { aud: null }],
    ["an issuer outside the accepted forms", { iss: "https://api.descope.com/v1/apps/P2otherProject" }],
  ])("refuses %s", async (_label, overrides) => {
    await expect(configuredVerifier().verify(await realShapeToken(overrides))).rejects.toThrow(
      "descope verifier: token rejected",
    );
  });

  it("DESCOPE_JWT_AUDIENCE overrides the default audience", async () => {
    process.env["DESCOPE_JWT_AUDIENCE"] = "custom-aud";
    expect(descopeVerifierConfig(PROJECT_ID).audience).toBe("custom-aud");
    await expect(configuredVerifier().verify(await realShapeToken())).rejects.toThrow("token rejected");
    await expect(configuredVerifier().verify(await realShapeToken({ aud: "custom-aud" }))).resolves.toEqual({
      providerKey: "descope",
      sub: SUB,
    });
  });

  it.each(["http://insecure.example", "issuer with spaces", "https://has space", "ftp://x"])(
    "a malformed DESCOPE_JWT_ISSUER %p fails at config time",
    (bad) => {
      process.env["DESCOPE_JWT_ISSUER"] = bad;
      expect(() => descopeVerifierConfig(PROJECT_ID)).toThrow(/DESCOPE_JWT_ISSUER/);
    },
  );

  it("a bare project id is a valid DESCOPE_JWT_ISSUER", () => {
    process.env["DESCOPE_JWT_ISSUER"] = PROJECT_ID;
    expect(descopeVerifierConfig(PROJECT_ID).issuer).toEqual([PROJECT_ID]);
  });

  it("DESCOPE_JWT_ISSUER replaces the accepted issuer forms", async () => {
    process.env["DESCOPE_JWT_ISSUER"] = "https://issuer.override.example";
    expect(descopeVerifierConfig(PROJECT_ID).issuer).toEqual(["https://issuer.override.example"]);
    await expect(configuredVerifier().verify(await realShapeToken())).rejects.toThrow("token rejected");
  });
});
