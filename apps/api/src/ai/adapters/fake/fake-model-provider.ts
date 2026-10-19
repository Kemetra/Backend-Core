/**
 * FakeModelProvider — RT-655. A deterministic, scriptable, network-free
 * `ModelProviderPort` for tests and the offline eval harness (RT-648).
 *
 * It is NEVER bound by default: AiModule binds `DisabledModelProvider`, and a
 * route naming providerKey "fake" is only reachable when a test allowlists it
 * (and a synthetic-only route is refused in production, E-9).
 */
import { preCallResult } from "../pre-call-checks";
import type {
  ModelProviderPort,
  ModelRequest,
  ModelResult,
} from "../../ports/model-provider.port";
import { estimateInputTokens } from "../../token-estimate";

export type FakeModelBehavior =
  /** Default. Deterministic: cites every evidence ref, sorted. */
  | { readonly kind: "echo" }
  /** Return exactly this result. */
  | { readonly kind: "result"; readonly result: ModelResult }
  /** Never settle until the signal aborts, then `unavailable/timeout`. */
  | { readonly kind: "hang" }
  /** Models a programmer error: the only case an adapter may throw. */
  | { readonly kind: "throw"; readonly error: Error };

export interface FakeModelProviderOptions {
  readonly providerKey: string;
  readonly behavior?: FakeModelBehavior;
}

export class FakeModelProvider implements ModelProviderPort {
  readonly providerKey: string;
  private readonly behavior: FakeModelBehavior;
  private readonly received: ModelRequest[] = [];
  private consultations = 0;

  constructor(options: FakeModelProviderOptions) {
    this.providerKey = options.providerKey;
    this.behavior = options.behavior ?? { kind: "echo" };
  }

  /** Every request `generate` was called with, in order. */
  get calls(): readonly ModelRequest[] {
    return this.received;
  }

  /** Times the scripted behavior was actually consulted (after pre-call checks). */
  get behaviorConsultations(): number {
    return this.consultations;
  }

  async generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResult> {
    this.received.push(request);
    const rejected = preCallResult(request, signal);
    if (rejected !== null) return rejected;

    this.consultations += 1;
    switch (this.behavior.kind) {
      case "result":
        return this.behavior.result;
      case "throw":
        throw this.behavior.error;
      case "hang":
        return new Promise<ModelResult>((resolve) => {
          signal.addEventListener("abort", () => resolve({ kind: "unavailable", cause: "timeout" }), {
            once: true,
          });
        });
      case "echo":
        return this.echo(request);
    }
  }

  private echo(request: ModelRequest): ModelResult {
    const evidenceRefs = request.evidencePack.items.map((item) => item.ref).sort();
    return {
      kind: "ok",
      rawOutput: { summary: "fake-summary", evidenceRefs },
      usage: { inputTokens: estimateInputTokens(request), outputTokens: 8, reported: true },
    };
  }
}
