/**
 * DisabledModelProvider — RT-655. The default-bound `ModelProviderPort`: the
 * `NoOpEmailAdapter` pattern. It never reaches a provider and reports the
 * condition as a value (`unavailable/disabled`), so a mis-wired route degrades
 * to the deterministic fallback instead of failing.
 */
import type {
  ModelProviderPort,
  ModelRequest,
  ModelResult,
} from "../../ports/model-provider.port";

export class DisabledModelProvider implements ModelProviderPort {
  readonly providerKey = "disabled";

  async generate(_request: ModelRequest, _signal: AbortSignal): Promise<ModelResult> {
    return { kind: "unavailable", cause: "disabled" };
  }
}
