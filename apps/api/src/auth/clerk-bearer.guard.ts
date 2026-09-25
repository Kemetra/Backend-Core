/**
 * Requires `Authorization: Bearer <jwt>` and stashes the raw token on the
 * request. JWT verification stays in the POS service, which already refuses
 * an invalid Clerk token with the same 401. This guard only removes the
 * "new method is public until someone remembers the header check" default.
 */
import { CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";

import { readBearerHeader, type CredentialRequest } from "./route-auth";

@Injectable()
export class ClerkBearerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<CredentialRequest>();
    const header = request.headers["authorization"];
    const token = readBearerHeader(typeof header === "string" ? header : undefined);
    if (token === null) throw new UnauthorizedException("Unauthorized");
    request.posBearer = token;
    return true;
  }
}
