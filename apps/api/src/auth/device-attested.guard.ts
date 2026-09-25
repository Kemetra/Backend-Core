/**
 * Marker guard. `@DeviceAttested()` tells the global guard not to run the
 * opaque token lookup. Body and bearer checks stay in the handler so the
 * Zod pipe can return 400 before any 401.
 */
import { CanActivate, Injectable } from "@nestjs/common";

@Injectable()
export class DeviceAttestedGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
