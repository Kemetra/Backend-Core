import { BadRequestException } from '@nestjs/common';

const SCALE = 10_000n;
const MAX_SCALED = 10n ** 19n - 1n;

/** Inventory-local numeric(19,4) arithmetic; settlement money has a separate domain policy. */
export function parseQuantity(value: string, field = 'quantity'): bigint {
  const match = /^(-?)(\d{1,15})(?:\.(\d{1,4}))?$/.exec(value);
  if (!match) {
    throw new BadRequestException(`${field} must be a numeric(19,4) decimal string`);
  }
  const magnitude = BigInt(match[2]!) * SCALE + BigInt((match[3] ?? '').padEnd(4, '0'));
  return match[1] === '-' ? -magnitude : magnitude;
}

export function formatQuantity(scaled: bigint, field = 'quantity'): string {
  const magnitude = scaled < 0n ? -scaled : scaled;
  if (magnitude > MAX_SCALED) {
    throw new BadRequestException(`${field} exceeds numeric(19,4) range`);
  }
  return `${scaled < 0n ? '-' : ''}${magnitude / SCALE}.${(magnitude % SCALE).toString().padStart(4, '0')}`;
}
