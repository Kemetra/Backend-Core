/**
 * Global fail-closed guard (#615).
 *
 * No marker means "authenticate with AuthGuard" (cookie or opaque bearer).
 * `@Public()` is the only way to skip authentication. Clerk and
 * device-attested routes declare their credential and do not fall through
 * to the opaque-token lookup, which would reject a Clerk JWT.
 */
import { CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { AuthGuard } from "./auth.guard";
import { ClerkBearerGuard } from "./clerk-bearer.guard";
import { DeviceAttestedGuard } from "./device-attested.guard";
import {
  CLERK_BEARER_KEY,
  DEVICE_ATTESTED_KEY,
  DEVICE_BEARER_KEY,
  IS_PUBLIC_KEY,
} from "./route-auth";

@Injectable()
export class FailClosedAuthGuard implements CanActivate {
  private readonly clerkBearer = new ClerkBearerGuard();
  private readonly deviceAttested = new DeviceAttestedGuard();

  constructor(
    private readonly reflector: Reflector,
    private readonly authGuard: AuthGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) === true) {
      return true;
    }
    if (this.reflector.getAllAndOverride<boolean>(CLERK_BEARER_KEY, targets) === true) {
      return this.clerkBearer.canActivate(context);
    }
    if (this.reflector.getAllAndOverride<boolean>(DEVICE_ATTESTED_KEY, targets) === true) {
      return this.deviceAttested.canActivate();
    }
    if (this.reflector.getAllAndOverride<boolean>(DEVICE_BEARER_KEY, targets) === true) {
      return true;
    }
    return this.authGuard.canActivate(context);
  }
}
