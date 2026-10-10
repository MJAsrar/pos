import { describe, expect, it } from 'vitest';
import { countToMovement, roundQty } from './stock.js';

/**
 * The rule these protect is the one that would be invisible if broken: an
 * absolute quantity crossing between the counter and the website erases
 * whatever was sold in between, and nobody finds out until someone counts the
 * shelf again.
 */

describe('countToMovement', () => {
  it('turns a count into the difference it makes', () => {
    expect(countToMovement(50, 38)).toEqual({ delta: 12, qtyAfter: 50, unchanged: false });
  });

  it('goes negative when the shelf holds less than the record', () => {
    expect(countToMovement(2, 9)).toEqual({ delta: -7, qtyAfter: 2, unchanged: false });
  });

  it('says there is nothing to do when the count already matches', () => {
    expect(countToMovement(7, 7).unchanged).toBe(true);
    expect(countToMovement(7, 7).delta).toBe(0);
  });

  it('counts zero as a count, not as nothing', () => {
    // An empty shelf is a real answer and must move the figure to zero.
    expect(countToMovement(0, 4)).toEqual({ delta: -4, qtyAfter: 0, unchanged: false });
  });

  it('keeps three decimals, because wire sells by the metre', () => {
    expect(countToMovement(12.5, 10.25)).toEqual({ delta: 2.25, qtyAfter: 12.5, unchanged: false });
    expect(countToMovement(0.333, 0)).toEqual({ delta: 0.333, qtyAfter: 0.333, unchanged: false });
  });

  it('does not leave a floating-point crumb behind', () => {
    // 0.3 - 0.1 is 0.19999999999999998 unrounded, which would record a
    // movement that never quite adds up.
    expect(countToMovement(0.3, 0.1).delta).toBe(0.2);
  });

  it('works from a negative record, which happens when stock was never counted', () => {
    // Every item starts at zero and selling takes it below. Counting the
    // shelf is how it gets put right.
    expect(countToMovement(6, -1)).toEqual({ delta: 7, qtyAfter: 6, unchanged: false });
  });
});

describe('roundQty', () => {
  it('rounds to three places', () => {
    expect(roundQty(1.23456)).toBe(1.235);
    expect(roundQty(2)).toBe(2);
    expect(roundQty(-0.0004)).toBe(-0);
  });
});
