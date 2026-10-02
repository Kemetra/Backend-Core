/**
 * ConnectorEnvironmentGuard — RT-152 (RT-134 CS2) deployment-environment gate.
 *
 * Runs AFTER `ConnectorAuthGuard` (which attaches `request.connector`) on the
 * connector feed controllers and requires
 * `request.connector.environment === DEPLOYMENT_ENVIRONMENT`. A mismatch — or a
 * deployment with no valid `DEPLOYMENT_ENVIRONMENT` — is the generic CS1 403
 * `forbidden`: the body names neither environment. Guards run before
 * interceptors and handlers, so a refused request records no audit event, no
 * idempotency row and no posting/bin state change.
 *
 * NOT applied to the connector heartbeat, which stays available to every
 * active registration regardless of environment.
 */
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { resolveDeploymentEnvironment } from "../connector/deployment-environment";
import type { AuthedRequest } from "./auth.guard";

@Injectable()
export class ConnectorEnvironmentGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const connector = request.connector;
    // ConnectorAuthGuard always sets this; absence means misordered guards.
    if (!connector) throw new UnauthorizedException("Unauthorized");

    const deployment = resolveDeploymentEnvironment();
    if (deployment === null || connector.environment !== deployment) {
      throw new ForbiddenException({ code: "forbidden", message: "Forbidden" });
    }
    return true;
  }
}
