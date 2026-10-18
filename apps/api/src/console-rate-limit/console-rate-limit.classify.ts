/**
 * Route → console rate-limit class (RT-619, RT-574 D1/D3).
 *
 * Order: the shared exemption list, then `@ConsoleRateLimit(...)`, then the
 * DECLARED verb of the handler (GET/HEAD → `cheapRead`, anything else →
 * `write`). The declared verb rather than `request.method` keeps the runtime
 * and the ratchet snapshot from ever disagreeing (a HEAD on a GET route is
 * still `cheapRead`).
 */
import "reflect-metadata";

import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA } from "@nestjs/common/constants";

import type { ConsoleCostClass, ConsoleRateLimitClass } from "./console-rate-limit.config";
import { CONSOLE_RATE_LIMIT_CLASS_KEY } from "./console-rate-limit.decorator";
import { isConsoleRateLimitExempt } from "./console-rate-limit.exemptions";

const READ_VERBS: ReadonlySet<number> = new Set([RequestMethod.GET, RequestMethod.HEAD]);

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- Nest handlers and controller classes
type Fn = Function;

export function handlerKey(controller: Fn, handler: Fn): string {
  return `${controller.name}.${handler.name}`;
}

export function resolveConsoleRateLimitClass(controller: Fn, handler: Fn): ConsoleRateLimitClass {
  if (isConsoleRateLimitExempt(handlerKey(controller, handler))) return "exempt";
  const pinned = Reflect.getMetadata(CONSOLE_RATE_LIMIT_CLASS_KEY, handler) as ConsoleCostClass | undefined;
  if (pinned !== undefined) return pinned;
  const verb = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
  return verb !== undefined && READ_VERBS.has(verb) ? "cheapRead" : "write";
}
