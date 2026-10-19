/**
 * AiFeatureDefinition — RT-655. One registered AI feature: repo-owned,
 * versioned, and provider-neutral (RT-643 §8 anti-lock-in: prompts and schemas
 * never depend on a vendor feature). Registered in code; there is no
 * tenant-supplied feature, prompt, route or model.
 */
import { z } from "zod";

import type { ModelCapability } from "../ports/model-provider.port";

export interface AiFeatureDefinition<T = unknown> {
  /** e.g. "sync_doctor.explain_sale" (the D0 E1 route). */
  readonly featureId: string;
  /** Key into the static route allowlist. */
  readonly routeKey: string;
  readonly promptTemplateId: string;
  readonly promptTemplateVersion: string;
  /** Renders the system prompt from the repo-owned template. Never tenant text. */
  readonly renderSystemPrompt: () => string;
  /** Zod schema id + version, sent to the adapter for traceability. */
  readonly outputSchemaId: string;
  /** MUST be a strict object schema: extra fields are rejected, not stripped. */
  readonly outputSchema: z.ZodType<T>;
  /** The evidence refs the validated output cites; each must be in the pack sent. */
  readonly extractEvidenceRefs: (output: T) => readonly string[];
  /** Capabilities the route must declare (conformance-verified, never assumed). */
  readonly requiredCapabilities: readonly ModelCapability[];
}

/**
 * Boot-time guard: a non-strict schema would silently accept (or strip) fields
 * a model invented, which defeats "Backend-Core validation is authoritative".
 * A programmer error, so it throws at construction, not at request time.
 */
export function assertStrictOutputSchema(feature: AiFeatureDefinition): void {
  const schema = feature.outputSchema;
  if (!(schema instanceof z.ZodObject) || schema._def.unknownKeys !== "strict") {
    throw new Error(
      `AI feature "${feature.featureId}": outputSchema must be a strict object schema ` +
        `(z.object({...}).strict()) so unknown fields are rejected.`,
    );
  }
}
