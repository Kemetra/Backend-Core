/**
 * RT-17 cash-up refusals and their contract responses
 * (`pos-shifts.openapi.yaml` 1.1.0-draft). The service throws a
 * `ShiftCashUpError` naming the contract `error.code`; the controller maps it
 * to the HTTP status here. Messages never name a cause, an id or a scope.
 */
import { HttpException, HttpStatus } from "@nestjs/common";

export type ShiftCashUpFailure =
  | "validation_error"
  | "refused"
  | "shift_not_found"
  | "shift_payload_conflict"
  | "shift_already_open"
  | "shift_closed"
  | "shift_cashup_inconsistent"
  | "currency_mismatch"
  | "refund_ref_invalid";

const RESPONSES: Readonly<Record<ShiftCashUpFailure, { status: HttpStatus; message: string }>> = {
  validation_error: {
    status: HttpStatus.BAD_REQUEST,
    message: "the request does not fit the recorded shift",
  },
  refused: { status: HttpStatus.FORBIDDEN, message: "Forbidden" },
  shift_not_found: { status: HttpStatus.NOT_FOUND, message: "shift not found" },
  shift_payload_conflict: {
    status: HttpStatus.CONFLICT,
    message: "this fact is already recorded with a different payload",
  },
  shift_already_open: {
    status: HttpStatus.CONFLICT,
    message: "this terminal already has an open shift; close it first",
  },
  shift_closed: {
    status: HttpStatus.CONFLICT,
    message: "the shift is closed; a new cash movement cannot be added",
  },
  shift_cashup_inconsistent: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: "the cash-up arithmetic does not hold",
  },
  currency_mismatch: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: "a refund reference was refunded in another currency",
  },
  refund_ref_invalid: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: "a refund reference cannot be claimed by this close",
  },
};

export class ShiftCashUpError extends Error {
  constructor(readonly failure: ShiftCashUpFailure) {
    super(failure);
    this.name = "ShiftCashUpError";
  }
}

/** The contract response for a cash-up refusal; any other error is passed through. */
export function toShiftHttpError(err: unknown): unknown {
  if (!(err instanceof ShiftCashUpError)) return err;
  const { status, message } = RESPONSES[err.failure];
  return new HttpException({ code: err.failure, message }, status);
}
