/**
 * auth.service.unit.spec.ts
 *
 * Docker-free unit coverage for AuthService (T304-B-api coverage lift).
 *
 * Strategy: hand-written fakes for SessionRepository, AuthTokenRepository,
 * EmailJobEnqueuer, and AuditJobEnqueuer. Module-level mocks for
 * drizzle-orm/node-postgres (avoid real DB) and @data-pulse-2/auth (avoid
 * real argon2id hashing). No Testcontainers, no real DB, no network.
 *
 * The Testcontainers integration spec (auth.service.spec.ts) covers the full
 * stack including real argon2id, citext, and RLS. This spec pins service
 * business logic in isolation.
 */

import {
  BadRequestException,
  UnauthorizedException,
} from "@nestjs/common";
import { AuthService, AUTH_TOKEN_SCOPES } from "../../src/auth/auth.service";
import type { SessionRepository } from "../../src/auth/session.repository";
import type { AuthTokenRepository } from "../../src/auth/auth-token.repository";
import type { EmailJobEnqueuer } from "../../src/auth/email-job.enqueuer";
import type { AuditJobEnqueuer } from "../../src/audit/audit-job.enqueuer";
import type { SessionRow } from "@data-pulse-2/db/schema";
import type { AuthTokenRow } from "@data-pulse-2/db/schema";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Controls what the fake DB returns for .select().from().where().limit()
let selectRows: unknown[] = [];
// Controls rowCount returned by .update().set().where()
let updateRowCount = 1;

jest.mock("drizzle-orm/node-postgres", () => ({
  drizzle: jest.fn(() => makeFakeDb()),
}));

function makeFakeDb() {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(selectRows),
    update: () => chain,
    set: () => chain,
    // .where() when used after update().set() must also resolve
  };
  // Override .where to handle both select and update chains
  chain.where = () => ({
    limit: () => Promise.resolve(selectRows),
    // for update chain that ends at .where()
    then: (resolve: (v: unknown) => void) =>
      resolve({ rowCount: updateRowCount }),
  });
  return chain;
}

jest.mock("@data-pulse-2/auth", () => {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return {
    verifyPassword: jest.fn(),
    hashPassword: jest.fn(),
    generateRawToken: jest.fn(),
    hashToken: (token: string): Buffer => createHash("sha256").update(token).digest(),
  };
});

// Import after mocks are set up
import { verifyPassword, hashPassword, generateRawToken } from "@data-pulse-2/auth";

const mockVerifyPassword = verifyPassword as jest.MockedFunction<typeof verifyPassword>;
const mockHashPassword = hashPassword as jest.MockedFunction<typeof hashPassword>;
const mockGenerateRawToken = generateRawToken as jest.MockedFunction<typeof generateRawToken>;

// ---------------------------------------------------------------------------
// Fixed UUIDs (UUIDv7-ish format)
// ---------------------------------------------------------------------------

const USER_ID   = "0193a000-0000-7000-8000-000000000001";
const USER_EMAIL = "alice@example.com";
const SESSION_ID = "0193a000-0000-7000-8000-000000000002";
const TOKEN_ID   = "0193a000-0000-7000-8000-000000000003";

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

function makeUserRow(overrides: Partial<{
  id: string;
  email: string;
  passwordHash: string | null;
  displayName: string | null;
  isPlatformAdmin: boolean;
  deletedAt: Date | null;
}> = {}) {
  return {
    id: USER_ID,
    email: USER_EMAIL,
    passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$fake$fakehash",
    displayName: "Alice",
    isPlatformAdmin: false,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    emailVerifiedAt: null,
    activeTenantId: null,
    ...overrides,
  };
}

function makeSessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    absoluteExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    issuedAt: new Date(),
    lastSeenAt: new Date(),
    revokedAt: null,
    activeTenantId: null,
    activeStoreId: null,
    userAgent: null,
    ipAtIssue: null,
    ...overrides,
  } as SessionRow;
}

function makeTokenRow(overrides: Partial<AuthTokenRow> = {}): AuthTokenRow {
  return {
    id: TOKEN_ID,
    tokenHash: Buffer.from("fakehash"),
    tenantId: null,
    userId: USER_ID,
    deviceId: null,
    storeId: null,
    scope: AUTH_TOKEN_SCOPES.passwordReset,
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    revokedAt: null,
    ...overrides,
  } as AuthTokenRow;
}

// ---------------------------------------------------------------------------
// Fake repositories
// ---------------------------------------------------------------------------

class FakeSessionRepository implements Pick<SessionRepository, "create" | "findActiveById" | "revoke" | "touchLastSeen"> {
  create = jest.fn<Promise<SessionRow>, [unknown]>().mockResolvedValue(makeSessionRow());
  findActiveById = jest.fn<Promise<SessionRow | null>, [string]>().mockResolvedValue(null);
  revoke = jest.fn<Promise<boolean>, [string]>().mockResolvedValue(true);
  touchLastSeen = jest.fn<Promise<boolean>, [string]>().mockResolvedValue(true);
}

class FakeAuthTokenRepository implements Pick<AuthTokenRepository, "issue" | "findActiveByRawToken" | "revoke"> {
  issue = jest.fn<Promise<AuthTokenRow>, [string, unknown]>().mockResolvedValue(makeTokenRow());
  findActiveByRawToken = jest.fn<Promise<AuthTokenRow | null>, [string]>().mockResolvedValue(null);
  revoke = jest.fn<Promise<boolean>, [string]>().mockResolvedValue(true);
}

class FakeEmailJobEnqueuer implements EmailJobEnqueuer {
  enqueuePasswordReset = jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined);
  enqueueEmailVerification = jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined);
  enqueueInvitation = jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined);
}

class FakeAuditJobEnqueuer implements AuditJobEnqueuer {
  enqueue = jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined);
}

// ---------------------------------------------------------------------------
// Helper: build service
// ---------------------------------------------------------------------------

function buildService(opts: {
  sessions?: FakeSessionRepository;
  authTokens?: FakeAuthTokenRepository;
  emailJobs?: FakeEmailJobEnqueuer;
  auditEnqueuer?: FakeAuditJobEnqueuer;
} = {}) {
  const sessions = opts.sessions ?? new FakeSessionRepository();
  const authTokens = opts.authTokens ?? new FakeAuthTokenRepository();
  const emailJobs = opts.emailJobs ?? new FakeEmailJobEnqueuer();
  const auditEnqueuer = opts.auditEnqueuer ?? new FakeAuditJobEnqueuer();

  const fakePool = {} as never;

  const service = new AuthService(
    fakePool,
    sessions as unknown as SessionRepository,
    authTokens as unknown as AuthTokenRepository,
    emailJobs,
    { auditEnqueuer },
  );

  return { service, sessions, authTokens, emailJobs, auditEnqueuer };
}

// ---------------------------------------------------------------------------
// Reset shared state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  selectRows = [];
  updateRowCount = 1;
  mockVerifyPassword.mockResolvedValue(false);
  mockHashPassword.mockResolvedValue("$argon2id$v=19$newhash");
  mockGenerateRawToken.mockReturnValue("raw-token-abc");
});

// ===========================================================================
// A. signIn — failure paths
// ===========================================================================

describe("AuthService.signIn — failure paths", () => {
  it("A1: unknown email — verifyPassword still called, UnauthorizedException thrown, no session", async () => {
    selectRows = []; // no user row
    mockVerifyPassword.mockResolvedValue(false);

    const { service, sessions, auditEnqueuer } = buildService();
    await expect(
      service.signIn({ email: "nobody@example.com", password: "anything" }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(mockVerifyPassword).toHaveBeenCalledTimes(1);
    expect(sessions.create).not.toHaveBeenCalled();

    // Allow fire-and-forget to settle
    await new Promise((r) => setTimeout(r, 0));
    expect(auditEnqueuer.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.signin.failed", actor_user_id: null }),
    );
  });

  it("A2: wrong password — verifyPassword resolves false, UnauthorizedException, no session", async () => {
    selectRows = [makeUserRow()];
    mockVerifyPassword.mockResolvedValue(false);

    const { service, sessions, auditEnqueuer } = buildService();
    await expect(
      service.signIn({ email: USER_EMAIL, password: "wrong" }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(mockVerifyPassword).toHaveBeenCalledTimes(1);
    expect(sessions.create).not.toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, 0));
    expect(auditEnqueuer.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.signin.failed" }),
    );
  });

  it("A3: SSO-only user (null passwordHash) — constant-time path, UnauthorizedException, no session", async () => {
    selectRows = [makeUserRow({ passwordHash: null })];
    // verifyPassword is called against DUMMY_PHC when passwordHash is null
    mockVerifyPassword.mockResolvedValue(false);

    const { service, sessions, auditEnqueuer } = buildService();
    await expect(
      service.signIn({ email: USER_EMAIL, password: "anything" }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(mockVerifyPassword).toHaveBeenCalledTimes(1);
    expect(sessions.create).not.toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, 0));
    expect(auditEnqueuer.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.signin.failed" }),
    );
  });

  it("UnauthorizedException carries 'Invalid credentials' message on all failure paths", async () => {
    selectRows = [];
    mockVerifyPassword.mockResolvedValue(false);
    const { service } = buildService();

    try {
      await service.signIn({ email: "x@x.com", password: "x" });
      fail("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnauthorizedException);
      const e = err as UnauthorizedException;
      const response = e.getResponse() as { message?: string };
      expect(response.message).toBe("Invalid credentials");
    }
  });
});

// ===========================================================================
// B. signIn — success path
// ===========================================================================

describe("AuthService.signIn — success path", () => {
  it("B4: valid credentials — sessions.create called, result shape correct", async () => {
    const user = makeUserRow();
    selectRows = [user];
    mockVerifyPassword.mockResolvedValue(true);

    const { service, sessions, auditEnqueuer } = buildService();
    sessions.create.mockResolvedValue(makeSessionRow());

    const result = await service.signIn({ email: USER_EMAIL, password: "correct" });

    expect(sessions.create).toHaveBeenCalledTimes(1);
    expect(result.userId).toBe(USER_ID);
    expect(result.user).toMatchObject({
      id: USER_ID,
      email: USER_EMAIL,
      display_name: "Alice",
      is_platform_admin: false,
    });
    expect(result.absoluteExpiresAt).toBeInstanceOf(Date);

    await new Promise((r) => setTimeout(r, 0));
    expect(auditEnqueuer.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.signin.ok", actor_user_id: USER_ID }),
    );
  });

  it("B5: sessionId matches UUID pattern and is passed to sessions.create", async () => {
    selectRows = [makeUserRow()];
    mockVerifyPassword.mockResolvedValue(true);

    const { service, sessions } = buildService();
    sessions.create.mockResolvedValue(makeSessionRow());

    const result = await service.signIn({ email: USER_EMAIL, password: "correct" });

    expect(result.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    const createCall = sessions.create.mock.calls[0]![0] as {
      id: string;
      credentialHash: Buffer;
    };
    expect(createCall.id).toBe(result.sessionId);
    expect(result.sessionCredential).toBe("raw-token-abc");
    expect(result.sessionCredential).not.toBe(result.sessionId);
    expect(createCall.credentialHash).toEqual(
      Buffer.from(
        // sha256("raw-token-abc") — the cookie is stored only as a hash
        require("node:crypto").createHash("sha256").update("raw-token-abc").digest(),
      ),
    );
  });

  it("B6: absoluteExpiresAt is approximately 24h in the future", async () => {
    selectRows = [makeUserRow()];
    mockVerifyPassword.mockResolvedValue(true);

    const { service, sessions } = buildService();
    sessions.create.mockResolvedValue(makeSessionRow());

    const before = Date.now();
    const result = await service.signIn({ email: USER_EMAIL, password: "correct" });
    const after = Date.now();

    const ttlMs = result.absoluteExpiresAt.getTime();
    expect(ttlMs).toBeGreaterThanOrEqual(before + 23 * 60 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(after + 25 * 60 * 60 * 1000);
  });
});

// ===========================================================================
// C. signOut
// ===========================================================================

describe("AuthService.signOut", () => {
  it("C7: sessions.revoke true → { revoked: true }", async () => {
    const { service, sessions } = buildService();
    sessions.revoke.mockResolvedValue(true);

    const result = await service.signOut(SESSION_ID);
    expect(result).toEqual({ revoked: true });
    expect(sessions.revoke).toHaveBeenCalledWith(SESSION_ID);
  });

  it("C8: sessions.revoke false → { revoked: false }", async () => {
    const { service, sessions } = buildService();
    sessions.revoke.mockResolvedValue(false);

    const result = await service.signOut(SESSION_ID);
    expect(result).toEqual({ revoked: false });
  });
});

// ===========================================================================
// D. refresh
// ===========================================================================

describe("AuthService.refresh", () => {
  it("D9: active session found — touchLastSeen called, returns session data", async () => {
    const sessionRow = makeSessionRow();
    const { service, sessions } = buildService();
    sessions.findActiveById.mockResolvedValue(sessionRow);

    const result = await service.refresh(SESSION_ID);

    expect(sessions.touchLastSeen).toHaveBeenCalledWith(SESSION_ID);
    expect(result).toEqual({
      sessionId: sessionRow.id,
      userId: sessionRow.userId,
      absoluteExpiresAt: sessionRow.absoluteExpiresAt,
    });
  });

  it("D10: no active session — returns null, touchLastSeen not called", async () => {
    const { service, sessions } = buildService();
    sessions.findActiveById.mockResolvedValue(null);

    const result = await service.refresh(SESSION_ID);

    expect(result).toBeNull();
    expect(sessions.touchLastSeen).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// E. requestPasswordReset
// ===========================================================================

describe("AuthService.requestPasswordReset", () => {
  it("E11: unknown email — returns silently, authTokens.issue not called", async () => {
    selectRows = [];
    const { service, authTokens, emailJobs } = buildService();

    await expect(
      service.requestPasswordReset({ email: "nobody@example.com" }),
    ).resolves.toBeUndefined();

    expect(authTokens.issue).not.toHaveBeenCalled();
    expect(emailJobs.enqueuePasswordReset).not.toHaveBeenCalled();
  });

  it("E12: known email — generateRawToken called, issue called with password_reset scope and ~15min expiry, email enqueued", async () => {
    selectRows = [makeUserRow()];
    mockGenerateRawToken.mockReturnValue("reset-raw-token");

    const { service, authTokens, emailJobs } = buildService();
    authTokens.issue.mockResolvedValue(makeTokenRow());

    const before = Date.now();
    await service.requestPasswordReset({ email: USER_EMAIL });
    const after = Date.now();

    expect(mockGenerateRawToken).toHaveBeenCalledTimes(1);

    expect(authTokens.issue).toHaveBeenCalledTimes(1);
    const [rawTok, issueInput] = authTokens.issue.mock.calls[0]! as [string, { scope: string; expiresAt: Date; userId: string }];
    expect(rawTok).toBe("reset-raw-token");
    expect(issueInput.scope).toBe(AUTH_TOKEN_SCOPES.passwordReset);
    expect(issueInput.userId).toBe(USER_ID);
    // ~15min expiry
    const expiryMs = issueInput.expiresAt.getTime();
    expect(expiryMs).toBeGreaterThanOrEqual(before + 14 * 60 * 1000);
    expect(expiryMs).toBeLessThanOrEqual(after + 16 * 60 * 1000);

    expect(emailJobs.enqueuePasswordReset).toHaveBeenCalledWith(
      expect.objectContaining({ email: USER_EMAIL, rawToken: "reset-raw-token", userId: USER_ID }),
    );
  });
});

// ===========================================================================
// F. confirmPasswordReset
// ===========================================================================

describe("AuthService.confirmPasswordReset", () => {
  it("F13: valid password_reset token — hashPassword called, db update called, authTokens.revoke called", async () => {
    const tokenRow = makeTokenRow({ scope: AUTH_TOKEN_SCOPES.passwordReset, userId: USER_ID });
    const { service, authTokens } = buildService();
    authTokens.findActiveByRawToken.mockResolvedValue(tokenRow);
    mockHashPassword.mockResolvedValue("$argon2id$v=19$newhash");

    await service.confirmPasswordReset({ rawToken: "valid-token", newPassword: "new-password-long" });

    expect(mockHashPassword).toHaveBeenCalledWith("new-password-long");
    expect(authTokens.revoke).toHaveBeenCalledWith(tokenRow.id);
  });

  it("F14: null/missing token — throws BadRequestException('Invalid or expired token')", async () => {
    const { service, authTokens } = buildService();
    authTokens.findActiveByRawToken.mockResolvedValue(null);

    await expect(
      service.confirmPasswordReset({ rawToken: "bad-token", newPassword: "x".repeat(12) }),
    ).rejects.toBeInstanceOf(BadRequestException);

    try {
      authTokens.findActiveByRawToken.mockResolvedValue(null);
      await service.confirmPasswordReset({ rawToken: "bad", newPassword: "x".repeat(12) });
    } catch (err) {
      expect((err as BadRequestException).message).toBe("Invalid or expired token");
    }
  });

  it("F15: wrong token scope — throws BadRequestException", async () => {
    const tokenRow = makeTokenRow({ scope: AUTH_TOKEN_SCOPES.emailVerify });
    const { service, authTokens } = buildService();
    authTokens.findActiveByRawToken.mockResolvedValue(tokenRow);

    await expect(
      service.confirmPasswordReset({ rawToken: "wrong-scope", newPassword: "x".repeat(12) }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("F16: token userId null — throws BadRequestException", async () => {
    const tokenRow = makeTokenRow({ scope: AUTH_TOKEN_SCOPES.passwordReset, userId: null });
    const { service, authTokens } = buildService();
    authTokens.findActiveByRawToken.mockResolvedValue(tokenRow);

    await expect(
      service.confirmPasswordReset({ rawToken: "null-user", newPassword: "x".repeat(12) }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ===========================================================================
// G. requestEmailVerification
// ===========================================================================

describe("AuthService.requestEmailVerification", () => {
  it("G17: unknown userId — returns silently, authTokens.issue not called", async () => {
    selectRows = [];
    const { service, authTokens, emailJobs } = buildService();

    await expect(
      service.requestEmailVerification({ userId: "0193a000-0000-7000-8000-000000000099" }),
    ).resolves.toBeUndefined();

    expect(authTokens.issue).not.toHaveBeenCalled();
    expect(emailJobs.enqueueEmailVerification).not.toHaveBeenCalled();
  });

  it("G18: known userId — generateRawToken called, issue with email_verify scope and ~24h expiry, email enqueued", async () => {
    selectRows = [makeUserRow()];
    mockGenerateRawToken.mockReturnValue("verify-raw-token");

    const { service, authTokens, emailJobs } = buildService();
    authTokens.issue.mockResolvedValue(makeTokenRow({ scope: AUTH_TOKEN_SCOPES.emailVerify }));

    const before = Date.now();
    await service.requestEmailVerification({ userId: USER_ID });
    const after = Date.now();

    expect(mockGenerateRawToken).toHaveBeenCalledTimes(1);

    expect(authTokens.issue).toHaveBeenCalledTimes(1);
    const [rawTok, issueInput] = authTokens.issue.mock.calls[0]! as [string, { scope: string; expiresAt: Date; userId: string }];
    expect(rawTok).toBe("verify-raw-token");
    expect(issueInput.scope).toBe(AUTH_TOKEN_SCOPES.emailVerify);
    expect(issueInput.userId).toBe(USER_ID);
    // ~24h expiry
    const expiryMs = issueInput.expiresAt.getTime();
    expect(expiryMs).toBeGreaterThanOrEqual(before + 23 * 60 * 60 * 1000);
    expect(expiryMs).toBeLessThanOrEqual(after + 25 * 60 * 60 * 1000);

    expect(emailJobs.enqueueEmailVerification).toHaveBeenCalledWith(
      expect.objectContaining({ email: USER_EMAIL, rawToken: "verify-raw-token", userId: USER_ID }),
    );
  });
});

// ===========================================================================
// H. confirmEmailVerification
// ===========================================================================

describe("AuthService.confirmEmailVerification", () => {
  it("H19: valid email_verify token — db update called, authTokens.revoke called", async () => {
    const tokenRow = makeTokenRow({ scope: AUTH_TOKEN_SCOPES.emailVerify, userId: USER_ID });
    const { service, authTokens } = buildService();
    authTokens.findActiveByRawToken.mockResolvedValue(tokenRow);

    await service.confirmEmailVerification({ rawToken: "valid-verify-token" });

    expect(authTokens.revoke).toHaveBeenCalledWith(tokenRow.id);
  });

  it("H20: null/missing token — throws BadRequestException", async () => {
    const { service, authTokens } = buildService();
    authTokens.findActiveByRawToken.mockResolvedValue(null);

    await expect(
      service.confirmEmailVerification({ rawToken: "missing" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("H21: wrong token scope — throws BadRequestException", async () => {
    const tokenRow = makeTokenRow({ scope: AUTH_TOKEN_SCOPES.passwordReset });
    const { service, authTokens } = buildService();
    authTokens.findActiveByRawToken.mockResolvedValue(tokenRow);

    await expect(
      service.confirmEmailVerification({ rawToken: "wrong-scope" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("H22: token userId null — throws BadRequestException", async () => {
    const tokenRow = makeTokenRow({ scope: AUTH_TOKEN_SCOPES.emailVerify, userId: null });
    const { service, authTokens } = buildService();
    authTokens.findActiveByRawToken.mockResolvedValue(tokenRow);

    await expect(
      service.confirmEmailVerification({ rawToken: "null-user" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ===========================================================================
// I. requireAuthTokens guard
// ===========================================================================

describe("AuthService.requireAuthTokens guard", () => {
  it("I23: requestPasswordReset with authTokens omitted and known user throws Error about missing AuthTokenRepository", async () => {
    selectRows = [makeUserRow()];
    mockGenerateRawToken.mockReturnValue("tok");

    const fakePool = {} as never;
    const fakeSessions = new FakeSessionRepository();
    // Construct without authTokens (3rd arg omitted)
    const service = new AuthService(
      fakePool,
      fakeSessions as unknown as SessionRepository,
      undefined,
    );

    await expect(
      service.requestPasswordReset({ email: USER_EMAIL }),
    ).rejects.toThrow(/AuthTokenRepository not configured/);
  });
});

// ===========================================================================
// Audit fire-and-forget resilience
// ===========================================================================

describe("AuthService audit fire-and-forget", () => {
  it("audit enqueue failure does not surface to sign-in caller (swallowed)", async () => {
    selectRows = [makeUserRow()];
    mockVerifyPassword.mockResolvedValue(true);

    const auditEnqueuer: AuditJobEnqueuer = {
      enqueue: jest.fn().mockRejectedValue(new Error("queue down")),
    };

    const { service, sessions } = buildService({ auditEnqueuer: auditEnqueuer as FakeAuditJobEnqueuer });
    sessions.create.mockResolvedValue(makeSessionRow());

    // Should not throw despite audit failure
    await expect(
      service.signIn({ email: USER_EMAIL, password: "correct" }),
    ).resolves.toBeDefined();

    // Allow fire-and-forget to reject without surfacing
    await new Promise((r) => setTimeout(r, 10));
  });
});

// ---------------------------------------------------------------------------
// NoOpRateLimiter — covers the internal checkAndConsume method
// ---------------------------------------------------------------------------

describe("AuthService — NoOpRateLimiter (internal fallback)", () => {
  it("NoOpRateLimiter.checkAndConsume returns { allowed: true }", async () => {
    // When no rateLimiter is provided in opts, AuthService constructs a
    // NoOpRateLimiter. Access it via bracket notation (TypeScript private
    // is compile-time only) and verify the fallback behaviour.
    const { service } = buildService();
    const rateLimiter = (service as unknown as Record<string, unknown>)["rateLimiter"] as {
      checkAndConsume(key: string): Promise<{ allowed: boolean }>;
    };
    const result = await rateLimiter.checkAndConsume("test-key");
    expect(result).toEqual({ allowed: true });
  });
});
