/**
 * @ConsoleRateLimit — RT-619 (RT-574 D1/D3).
 *
 * Pins a console route to an explicit cost class. A route without it falls
 * back to its HTTP verb (GET/HEAD → `cheapRead`, any other verb → `write`),
 * so a forgotten annotation never leaves a route unlimited; the ratchet
 * snapshot (test/console-rate-limit/console-rate-limit.ratchet.spec.ts)
 * forces every console operation to be reviewed explicitly.
 *
 * `exempt` is deliberately NOT accepted here: exemptions live in the one
 * shared list (`console-rate-limit.exemptions.ts`) that the runtime and the
 * RT-620 contract sweep both read.
 */
import { SetMetadata } from "@nestjs/common";

import type { ConsoleCostClass } from "./console-rate-limit.config";

export const CONSOLE_RATE_LIMIT_CLASS_KEY = "dp2:console-rate-limit:class";

export const ConsoleRateLimit = (costClass: ConsoleCostClass) =>
  SetMetadata(CONSOLE_RATE_LIMIT_CLASS_KEY, costClass);
