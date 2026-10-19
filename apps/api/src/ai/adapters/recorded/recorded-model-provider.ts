/**
 * RecordedModelProvider — RT-655. Replays recorded provider outcomes, the
 * `recordedItemView` pattern (erpnext-item-view.port.ts) applied to the model
 * port. This is how a future vendor adapter's wire mapping (RT-657) and the
 * offline eval harness (RT-648) run in CI with NO network and NO credentials.
 *
 * Fixtures are keyed `<promptTemplateId>@<promptTemplateVersion>`. A request
 * with no recorded fixture throws loudly: that is a test-authoring (programmer)
 * error, never a provider condition.
 */
import { preCallResult } from "../pre-call-checks";
import type {
  ModelProviderPort,
  ModelRequest,
  ModelResult,
} from "../../ports/model-provider.port";

export interface RecordedModelProviderOptions {
  readonly providerKey: string;
  readonly fixtures: Readonly<Record<string, ModelResult>>;
}

export class RecordedModelProvider implements ModelProviderPort {
  readonly providerKey: string;
  private readonly fixtures: Readonly<Record<string, ModelResult>>;
  private consultations = 0;

  constructor(options: RecordedModelProviderOptions) {
    this.providerKey = options.providerKey;
    this.fixtures = options.fixtures;
  }

  /** Times a recorded fixture was actually replayed (after pre-call checks). */
  get fixtureConsultations(): number {
    return this.consultations;
  }

  generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResult> {
    const rejected = preCallResult(request, signal);
    if (rejected !== null) return Promise.resolve(rejected);

    const key = `${request.promptTemplateId}@${request.promptTemplateVersion}`;
    const fixture = this.fixtures[key];
    if (fixture === undefined) {
      return Promise.reject(new Error(`No recorded fixture for "${key}"`));
    }
    this.consultations += 1;
    return Promise.resolve(fixture);
  }
}
