import { BadRequestException } from '@nestjs/common';

import { formatQuantity, parseQuantity } from '../../src/inventory/decimal-quantity';

describe('numeric(19,4) inventory quantities', () => {
  it('round-trips all legal digits without floating-point loss', () => {
    expect(formatQuantity(parseQuantity('12345678901234.5678'))).toBe('12345678901234.5678');
    expect(formatQuantity(parseQuantity('-12345678901234.5678'))).toBe('-12345678901234.5678');
    expect(formatQuantity(parseQuantity('999999999999999.9999'))).toBe('999999999999999.9999');
  });

  it('subtracts exact scaled values, including negative fractional quantities', () => {
    expect(formatQuantity(parseQuantity('12345678901234.5678') - parseQuantity('12345678901234.5677'))).toBe('0.0001');
    expect(formatQuantity(parseQuantity('0.0001') - parseQuantity('1.0000'))).toBe('-0.9999');
  });

  it.each(['1000000000000000.0000', '0.00001', '1e3', 'NaN', 'Infinity'])('rejects out-of-shape input %s with 400', (value) => {
    expect(() => parseQuantity(value)).toThrow(BadRequestException);
  });

  it('rejects a calculated variance that exceeds numeric(19,4) with 400', () => {
    expect(() => formatQuantity(parseQuantity('999999999999999.9999') - parseQuantity('-0.0001'))).toThrow(BadRequestException);
  });
});
