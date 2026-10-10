import { describe, expect, it } from 'vitest';
import { PIN_HASH_COST, PIN_LENGTH, isValidPin, pinWeakness } from './pin.js';

/**
 * Both the counter and the website ask these questions now, so the answers
 * have to be the same in both. A PIN the till would refuse must not slip
 * through from a phone.
 */

describe('isValidPin', () => {
  it('wants exactly four digits', () => {
    expect(isValidPin('4729')).toBe(true);
    expect(isValidPin('472')).toBe(false);
    expect(isValidPin('47299')).toBe(false);
    expect(isValidPin('47a9')).toBe(false);
    expect(isValidPin('')).toBe(false);
    expect(isValidPin(' 472')).toBe(false);
  });
});

describe('pinWeakness', () => {
  it('passes an ordinary PIN', () => {
    expect(pinWeakness('4729')).toBeNull();
    expect(pinWeakness('1357')).toBeNull();
  });

  it('refuses the same digit over and over', () => {
    for (const pin of ['0000', '1111', '9999']) {
      expect(pinWeakness(pin)).toMatch(/same digit/i);
    }
  });

  it('refuses the three everyone tries first', () => {
    for (const pin of ['1234', '0000', '4321']) {
      expect(pinWeakness(pin)).toBeTruthy();
    }
  });

  it('says what is wrong with the wrong length, not just that it is wrong', () => {
    expect(pinWeakness('12')).toBe(`The PIN must be exactly ${PIN_LENGTH} digits.`);
  });

  it('does not refuse so much that people write them down', () => {
    // A deliberate limit on how clever this gets: the list is short.
    const refused = ['1234', '4321', '0000', '1111', '2222'];
    const accepted = ['1243', '2580', '9137', '1593', '7410'];
    for (const pin of refused) expect(pinWeakness(pin)).toBeTruthy();
    for (const pin of accepted) expect(pinWeakness(pin)).toBeNull();
  });
});

describe('PIN_HASH_COST', () => {
  it('is expensive enough to be worth having', () => {
    // Four digits is ten thousand guesses. The cost per guess is the defence,
    // so a well-meaning reduction here would quietly remove it.
    expect(PIN_HASH_COST.memoryCost).toBeGreaterThanOrEqual(19_456);
    expect(PIN_HASH_COST.timeCost).toBeGreaterThanOrEqual(2);
  });
});
