/**
 * RT-791 test helper — a fake Descope project: a locally generated RS256 key,
 * a local HTTP JWKS endpoint, and a token minter. Nothing reaches Descope.
 * The returned verifier is the REAL `DescopeJwksVerifier` over a real
 * `createRemoteJWKSet` pointed at the local server, with the production
 * issuer/audience rules. Minted tokens follow the real session-JWT shape
 * (iss = https://api.descope.com/v1/apps/<projectId>, aud = <projectId>).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { SignJWT, createRemoteJWKSet, exportJWK, generateKeyPair, type KeyLike } from "jose";

import {
  DescopeJwksVerifier,
  descopeIssuer,
  descopeVerifierConfig,
} from "../../src/pos-operators/descope-verifier";

export interface MintOptions {
  readonly issuer?: string;
  readonly audience?: string;
  readonly foreignKey?: boolean;
  readonly expired?: boolean;
}

export interface FakeDescopeProject {
  readonly issuer: string;
  readonly verifier: DescopeJwksVerifier;
  /** Mint a session JWT; overrides let a test break one property. */
  mint(sub: string, opts?: MintOptions): Promise<string>;
  close(): Promise<void>;
}

export async function startFakeDescopeProject(projectId: string): Promise<FakeDescopeProject> {
  const kid = "fake-descope-kid";
  const pair = await generateKeyPair("RS256");
  const foreign: KeyLike = (await generateKeyPair("RS256")).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid, alg: "RS256", use: "sig" };

  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks.json`);

  const issuer = descopeIssuer(projectId);
  // Same issuer + audience rules the production factory enforces.
  const verifier = new DescopeJwksVerifier({ ...descopeVerifierConfig(projectId), jwks: createRemoteJWKSet(url) });

  return {
    issuer,
    verifier,
    mint(sub, opts = {}) {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ drn: "DS" })
        .setProtectedHeader({ alg: "RS256", kid })
        .setSubject(sub)
        .setIssuer(opts.issuer ?? issuer)
        .setAudience(opts.audience ?? projectId)
        .setIssuedAt(opts.expired ? now - 3600 : now)
        .setExpirationTime(opts.expired ? now - 600 : now + 300)
        .sign(opts.foreignKey ? foreign : pair.privateKey);
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
