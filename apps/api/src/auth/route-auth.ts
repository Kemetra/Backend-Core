/**
 * Route-auth markers for the fail-closed global guard (#615).
 *
 * A route with none of these markers must present a dashboard cookie or an
 * opaque bearer token. `@Public()` is the only opt-out. Operator-token POS routes
 * and device-attested audit ingestion declare their own credential instead
 * of becoming public.
 */
import { SetMetadata, UnauthorizedException, UseInterceptors, applyDecorators } from "@nestjs/common";
import type { Request } from "express";

import { DeviceRotationHintInterceptor } from "../pos-terminal-pairing/rotation-hint";

export const IS_PUBLIC_KEY = "dp2:public";
export const OPERATOR_BEARER_KEY = "dp2:operatorBearer";
export const DEVICE_ATTESTED_KEY = "dp2:deviceAttested";
export const DEVICE_BEARER_KEY = "dp2:deviceBearer";
export const REPORTS_BUILD_IDENTITY_KEY = "dp2:reportsBuildIdentity";

export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
export const OperatorBearer = () => SetMetadata(OPERATOR_BEARER_KEY, true);
export const DeviceAttested = () => SetMetadata(DEVICE_ATTESTED_KEY, true);
/**
 * Paired-terminal bearer. PosDeviceAuthGuard on the route does the lookup.
 * Also installs the rotate-soon hint interceptor (RT-639), which writes the hint
 * headers after a successful handler; it does nothing on a route whose guard
 * recorded no expiry (the rotation route's own guard).
 */
export const DeviceBearer = () =>
  applyDecorators(SetMetadata(DEVICE_BEARER_KEY, true), UseInterceptors(DeviceRotationHintInterceptor));

/**
 * RT-719: the route is one of the thirteen build identity REPORTING operations
 * (`pos-terminal-pairing.openapi.yaml`, "Build identity report"). Its
 * device-token request carries the optional `X-POS-*` headers, which
 * `PosDeviceAuthGuard` reads and passes to the activity write. A device-token
 * route without this marker neither records nor clears the identity.
 * `build-identity-markers.spec.ts` pins the exact set.
 */
export const ReportsBuildIdentity = () => SetMetadata(REPORTS_BUILD_IDENTITY_KEY, true);

export type CredentialRequest = Request & {
  posBearer?: string;
};

export function readBearerHeader(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trimStart();
  const prefix = "bearer ";
  if (trimmed.length < prefix.length) return null;
  if (trimmed.slice(0, prefix.length).toLowerCase() !== prefix) return null;
  const token = trimmed.slice(prefix.length).trim();
  return token.length > 0 ? token : null;
}

export function requirePosBearer(req: CredentialRequest): string {
  if (!req.posBearer) throw new UnauthorizedException("Unauthorized");
  return req.posBearer;
}
