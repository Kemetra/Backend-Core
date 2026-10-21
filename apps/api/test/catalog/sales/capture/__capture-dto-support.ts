/**
 * __capture-dto-support.ts — shared helpers for Docker-free captureSale DTO
 * specs. NOT a spec (`__`-prefixed). Parses a body through the production
 * `CaptureSaleRequestPipe`, which picks the capture schema from the tender
 * deploy flags.
 */
import { ZodError } from "zod";

import { CaptureSaleRequestPipe } from "../../../../src/catalog/sales/dto/capture-sale-request.pipe";

export const TENDERS_FLAG = "POS_SALE_TENDERS_ENABLED";
export const SAME_METHOD_FLAG = "POS_SALE_TENDERS_SAME_METHOD_ENABLED";

/** Every capture schema the pipe can select, keyed by the flags that select it. */
export const CAPTURE_SCHEMA_VARIANTS: ReadonlyArray<[string, Record<string, string>]> = [
  ["tenders gate off", {}],
  ["tenders gate on", { [TENDERS_FLAG]: "true" }],
  ["same-method gate on", { [TENDERS_FLAG]: "true", [SAME_METHOD_FLAG]: "true" }],
];

const pipe = new CaptureSaleRequestPipe();

export function parseCapture(value: unknown): Record<string, unknown> {
  return pipe.transform(value, { type: "body" }) as unknown as Record<string, unknown>;
}

/** The body is a 400 `validation_error` at the boundary. */
export function expectCapture400(value: unknown): void {
  expect(() => parseCapture(value)).toThrow(ZodError);
}

export function clearTenderFlags(): void {
  delete process.env[TENDERS_FLAG];
  delete process.env[SAME_METHOD_FLAG];
}
