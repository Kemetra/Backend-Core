/**
 * #615 — a route with no auth marker is denied. @Public is the opt-out.
 */
import { Controller, Get, INestApplication, Injectable, UnauthorizedException } from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AuthGuard } from "../../src/auth/auth.guard";
import { FailClosedAuthGuard } from "../../src/auth/fail-closed-auth.guard";
import { Public } from "../../src/auth/route-auth";

@Injectable()
class DenyAllAuthGuard extends AuthGuard {
  constructor() {
    super({} as never, {} as never);
  }

  override async canActivate(): Promise<boolean> {
    throw new UnauthorizedException("Unauthorized");
  }
}

@Controller("probe")
class ProbeController {
  @Get("open")
  @Public()
  open(): { ok: true } {
    return { ok: true };
  }

  @Get("closed")
  closed(): { ok: true } {
    return { ok: true };
  }
}

describe("#615 fail-closed auth guard", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        Reflector,
        { provide: AuthGuard, useClass: DenyAllAuthGuard },
        { provide: APP_GUARD, useClass: FailClosedAuthGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("denies a route with no decorator", async () => {
    const res = await request(app.getHttpServer()).get("/probe/closed");
    expect(res.status).toBe(401);
  });

  it("allows @Public()", async () => {
    const res = await request(app.getHttpServer()).get("/probe/open");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
