/**
 * RT-639 — the "rotate soon" hint a device-token response carries.
 *
 * Once a device credential has 15 days or less left, every response to a
 * device-token call carries two headers (pos-terminal-pairing.openapi.yaml,
 * "Credential rotation"):
 *
 *   X-Device-Token-Rotate-After   ISO-8601 instant, `expires_at - 15 days`:
 *                                 the same instant the rotate response gives
 *                                 as `rotate_after`.
 *   X-Device-Token-Rotate-Stage   `notice` (15 days or less left),
 *                                 `warning` (10 or less), `urgent` (3 or less,
 *                                 or already past `expires_at`).
 *
 * The server keeps no per-device state, so it cannot say "once". It sends the
 * stage on every successful response while it holds; the terminal shows each
 * stage the first time it sees it. More than 15 days left: no header. The
 * computation is pure: the clock is a parameter.
 *
 * Only a SUCCESSFUL response carries them (the 2xx, and the 304 of a conditional
 * GET). `PosDeviceAuthGuard` records the expiry on the request;
 * `DeviceRotationHintInterceptor` (installed by `@DeviceBearer()`) writes the
 * headers once the handler has answered, so a response to a failed request, or
 * to one a later guard refused, carries none.
 *
 * Only an instant and a stage travel; never token material.
 */
import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import { tap } from "rxjs/operators";

const DAY_MS = 86_400_000;

/** How long before `expires_at` the hint starts (RT-138 L4: the rotate response's `rotate_after`). */
export const ROTATION_HINT_LEAD_MS = 15 * DAY_MS;

export const ROTATE_AFTER_HEADER = "X-Device-Token-Rotate-After";
export const ROTATE_STAGE_HEADER = "X-Device-Token-Rotate-Stage";

export type RotationStage = "notice" | "warning" | "urgent";

export interface RotationHint {
  readonly rotateAfter: Date;
  readonly stage: RotationStage;
}

/** Upper bounds of the remaining time for each stage, tightest first. */
const STAGES: readonly { readonly withinMs: number; readonly stage: RotationStage }[] = [
  { withinMs: 3 * DAY_MS, stage: "urgent" },
  { withinMs: 10 * DAY_MS, stage: "warning" },
  { withinMs: ROTATION_HINT_LEAD_MS, stage: "notice" },
];

/** The hint for a credential expiring at `expiresAt`, or null while more than 15 days remain. */
export function computeRotationHint(expiresAt: Date, now: Date): RotationHint | null {
  const remainingMs = expiresAt.getTime() - now.getTime();
  const stage = STAGES.find((s) => remainingMs <= s.withinMs)?.stage;
  if (stage === undefined) return null;
  return { rotateAfter: new Date(expiresAt.getTime() - ROTATION_HINT_LEAD_MS), stage };
}

/** Set the hint headers on `res` when one is due; otherwise leave it untouched. */
export function applyRotationHint(
  res: { setHeader: (name: string, value: string) => unknown },
  expiresAt: Date,
  now: Date = new Date(),
): void {
  const hint = computeRotationHint(expiresAt, now);
  if (hint === null) return;
  res.setHeader(ROTATE_AFTER_HEADER, hint.rotateAfter.toISOString());
  res.setHeader(ROTATE_STAGE_HEADER, hint.stage);
}

/** What `PosDeviceAuthGuard` leaves on the request for the interceptor. */
export interface RotationHintRequest {
  /** When the presented credential stops working; unset when the request used no device token. */
  deviceRotationExpiry?: Date;
}

/** Writes the hint headers after the handler has answered; a failing handler writes none. */
@Injectable()
export class DeviceRotationHintInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    return next.handle().pipe(
      tap(() => {
        const expiry = http.getRequest<RotationHintRequest>().deviceRotationExpiry;
        if (expiry !== undefined) {
          applyRotationHint(http.getResponse<{ setHeader: (k: string, v: string) => void }>(), expiry);
        }
      }),
    );
  }
}
