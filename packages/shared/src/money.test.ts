import { describe, expect, it } from 'vitest';
import {
  formatPKR,
  formatQty,
  lineTotal,
  parseMoneyInput,
  parseQtyInput,
  roundHalfUp,
  roundToRupee,
  roundingDelta,
  rupeesToPaisa,
  sumPaisa,
} from './money.js';

describe('roundHalfUp', () => {
  it('rounds halves away from zero in both directions', () => {
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(-2.5)).toBe(-3);
    expect(roundHalfUp(2.4)).toBe(2);
    expect(roundHalfUp(-2.4)).toBe(-2);
  });

  it('is symmetric, so a refund reverses its sale exactly', () => {
    for (const value of [0.5, 1.5, 12.5, 1249.5, 0.05]) {
      expect(roundHalfUp(value)).toBe(-roundHalfUp(-value));
    }
  });
});

describe('rupeesToPaisa', () => {
  it('converts without float drift', () => {
    expect(rupeesToPaisa(50)).toBe(5000);
    expect(rupeesToPaisa(0.1)).toBe(10);
    expect(rupeesToPaisa(1249.99)).toBe(124999);
    // 8.7 * 100 is 869.9999... in binary floating point
    expect(rupeesToPaisa(8.7)).toBe(870);
  });
});

describe('lineTotal', () => {
  it('multiplies whole units exactly', () => {
    expect(lineTotal(3, 25000)).toBe(75000);
  });

  it('rounds fractional quantities to whole paisa', () => {
    // 2.5 metres of wire at Rs 37.30/m = Rs 93.25
    expect(lineTotal(2.5, 3730)).toBe(9325);
    // 1.333 kg at Rs 100 = Rs 133.30
    expect(lineTotal(1.333, 10000)).toBe(13330);
  });

  it('rejects a non-finite quantity instead of producing NaN money', () => {
    expect(() => lineTotal(Number.NaN, 1000)).toThrow();
    expect(() => lineTotal(Infinity, 1000)).toThrow();
  });

  it('rejects a non-integer price', () => {
    expect(() => lineTotal(1, 10.5)).toThrow();
  });
});

describe('roundToRupee', () => {
  it('rounds to the nearest whole rupee', () => {
    expect(roundToRupee(124960)).toBe(125000);
    expect(roundToRupee(124940)).toBe(124900);
    expect(roundToRupee(124950)).toBe(125000);
    expect(roundToRupee(125000)).toBe(125000);
  });

  it('reports a delta that restores the original amount', () => {
    for (const amount of [124960, 124940, 1, 99, 100, 0]) {
      expect(amount + roundingDelta(amount)).toBe(roundToRupee(amount));
    }
  });
});

describe('formatPKR', () => {
  it('groups thousands and hides zero paisa', () => {
    expect(formatPKR(125000)).toBe('Rs 1,250');
    expect(formatPKR(100)).toBe('Rs 1');
    expect(formatPKR(0)).toBe('Rs 0');
    expect(formatPKR(123456789)).toBe('Rs 1,234,567.89');
  });

  it('shows paisa only when present', () => {
    expect(formatPKR(125050)).toBe('Rs 1,250.50');
    expect(formatPKR(125005)).toBe('Rs 1,250.05');
  });

  it('handles negative amounts, as a customer advance would be', () => {
    expect(formatPKR(-125000)).toBe('-Rs 1,250');
  });
});

describe('parseMoneyInput', () => {
  it('accepts what a cashier actually types', () => {
    expect(parseMoneyInput('1250')).toBe(125000);
    expect(parseMoneyInput('1,250')).toBe(125000);
    expect(parseMoneyInput('1250.50')).toBe(125050);
    expect(parseMoneyInput('Rs 1250')).toBe(125000);
    expect(parseMoneyInput('  1250  ')).toBe(125000);
  });

  it('returns null for anything ambiguous rather than guessing', () => {
    expect(parseMoneyInput('')).toBeNull();
    expect(parseMoneyInput('abc')).toBeNull();
    expect(parseMoneyInput('12.3.4')).toBeNull();
    expect(parseMoneyInput('1e5')).toBeNull();
  });
});

describe('parseQtyInput', () => {
  it('accepts positive numbers and trims to three decimals', () => {
    expect(parseQtyInput('3')).toBe(3);
    expect(parseQtyInput('2.5')).toBe(2.5);
    expect(parseQtyInput('1.3335')).toBe(1.334);
  });

  it('rejects zero, negatives and junk', () => {
    expect(parseQtyInput('0')).toBeNull();
    expect(parseQtyInput('-2')).toBeNull();
    expect(parseQtyInput('two')).toBeNull();
  });
});

describe('formatQty', () => {
  it('drops trailing zeros', () => {
    expect(formatQty(2)).toBe('2');
    expect(formatQty(2.5)).toBe('2.5');
    expect(formatQty(2.0)).toBe('2');
  });
});

describe('sumPaisa', () => {
  it('sums exactly, unlike repeated float addition', () => {
    const amounts = Array.from({ length: 1000 }, () => 10);
    expect(sumPaisa(amounts)).toBe(10000);
  });
});
