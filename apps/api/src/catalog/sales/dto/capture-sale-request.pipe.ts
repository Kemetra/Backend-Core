/**
 * RT-77 — the captureSale body pipe. Picks the schema PER REQUEST from the
 * `POS_SALE_TENDERS_ENABLED` gate: off (the default) → the pre-RT-77 strict
 * `CaptureSaleRequestSchema`, so `tenders` is an unknown key and the 400 body
 * is byte-identical to today; on → `CaptureSaleRequestWithTendersSchema`.
 * A ZodError is rendered by the GlobalExceptionFilter, as for ZodValidationPipe.
 */
import { Injectable, type ArgumentMetadata, type PipeTransform } from "@nestjs/common";

import { isPosSaleTendersEnabled } from "../sale-tenders-gate";
import {
  CaptureSaleRequestSchema,
  CaptureSaleRequestWithTendersSchema,
  type CaptureSaleRequestDto,
} from "./capture-sale-request.dto";

@Injectable()
export class CaptureSaleRequestPipe implements PipeTransform<unknown, CaptureSaleRequestDto> {
  transform(value: unknown, _metadata: ArgumentMetadata): CaptureSaleRequestDto {
    const schema = isPosSaleTendersEnabled()
      ? CaptureSaleRequestWithTendersSchema
      : CaptureSaleRequestSchema;
    return schema.parse(value);
  }
}
