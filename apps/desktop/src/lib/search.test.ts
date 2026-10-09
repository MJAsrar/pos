import { describe, expect, it } from 'vitest';
import { findByExactCode, parseQuantityPrefix, searchItems } from './search';
import type { Item } from './api';

function item(code: string, name: string): Item {
  return {
    id: code,
    code,
    name,
    categoryId: null,
    categoryName: null,
    unit: 'pcs',
    costPrice: 1000,
    salePrice: 2000,
    minPrice: null,
    qtyOnHand: 10,
    lowStockLevel: 0,
    photoPath: null,
    isActive: true,
    createdAt: '',
    updatedAt: '',
  };
}

const CATALOGUE: Item[] = [
  item('101', 'USB-C Cable 1m'),
  item('102', 'Micro USB Cable 1m'),
  item('103', 'Fast Charger 20W'),
  item('201', 'LED Bulb 12W'),
  item('202', 'LED Bulb 18W'),
  item('203', 'LED Bulb 7W'),
  item('204', 'LED Tube 20W 4ft'),
  item('W25', 'Wire 2.5mm Copper'),
  item('601', 'Exhaust Fan 8in'),
  item('602', 'Fan Capacitor 2.5uF'),
];

const names = (query: string) => searchItems(CATALOGUE, query).map((r) => r.item.name);

describe('searchItems', () => {
  it('puts an exact code first, above anything matching by name', () => {
    expect(names('101')[0]).toBe('USB-C Cable 1m');
    expect(names('W25')[0]).toBe('Wire 2.5mm Copper');
  });

  it('is case-insensitive about codes', () => {
    expect(names('w25')[0]).toBe('Wire 2.5mm Copper');
  });

  it('finds every item sharing a word', () => {
    expect(names('bulb')).toEqual(['LED Bulb 7W', 'LED Bulb 12W', 'LED Bulb 18W']);
  });

  it('matches a word anywhere in the name, not just the start', () => {
    expect(names('capacitor')).toEqual(['Fan Capacitor 2.5uF']);
  });

  it('requires every word typed to match', () => {
    expect(names('led tube')).toEqual(['LED Tube 20W 4ft']);
    expect(names('led sprocket')).toEqual([]);
  });

  it('ignores word order', () => {
    expect(names('bulb led 18')).toEqual(['LED Bulb 18W']);
  });

  it('ignores punctuation and spacing differences', () => {
    expect(names('usb c')[0]).toBe('USB-C Cable 1m');
    expect(names('usb-c')[0]).toBe('USB-C Cable 1m');
  });

  it('still finds an item when the spaces are left out', () => {
    expect(names('ledbulb')).toContain('LED Bulb 12W');
  });

  it('prefers the shorter name when two score the same', () => {
    expect(names('led bulb')[0]).toBe('LED Bulb 7W');
  });

  it('returns nothing for an empty or unmatched query', () => {
    expect(names('')).toEqual([]);
    expect(names('   ')).toEqual([]);
    expect(names('zzzzqqq')).toEqual([]);
  });

  it('caps how many results come back', () => {
    const many = Array.from({ length: 200 }, (_, i) => item(`X${i}`, `Widget ${i}`));
    expect(searchItems(many, 'widget', 40)).toHaveLength(40);
  });
});

describe('findByExactCode', () => {
  it('matches only an exact code', () => {
    expect(findByExactCode(CATALOGUE, '101')?.name).toBe('USB-C Cable 1m');
    expect(findByExactCode(CATALOGUE, ' 101 ')?.name).toBe('USB-C Cable 1m');
    expect(findByExactCode(CATALOGUE, '10')).toBeNull();
    expect(findByExactCode(CATALOGUE, 'LED')).toBeNull();
  });
});

describe('parseQuantityPrefix', () => {
  it('reads a quantity before the code', () => {
    expect(parseQuantityPrefix('5*101', CATALOGUE)).toEqual({ qty: 5, term: '101' });
    expect(parseQuantityPrefix('5 x 101', CATALOGUE)).toEqual({ qty: 5, term: '101' });
  });

  it('reads a quantity after the code', () => {
    // Ambiguous on its own: both sides are numbers. The catalogue settles it,
    // because 101 is a real item code and 5 is not.
    expect(parseQuantityPrefix('101*5', CATALOGUE)).toEqual({ qty: 5, term: '101' });
  });

  it('handles fractional quantities for wire', () => {
    expect(parseQuantityPrefix('2.5*W25', CATALOGUE)).toEqual({ qty: 2.5, term: 'W25' });
    expect(parseQuantityPrefix('W25*2.5', CATALOGUE)).toEqual({ qty: 2.5, term: 'W25' });
  });

  it('defaults to one when no quantity is given', () => {
    expect(parseQuantityPrefix('101', CATALOGUE)).toEqual({ qty: 1, term: '101' });
    expect(parseQuantityPrefix('led bulb', CATALOGUE)).toEqual({ qty: 1, term: 'led bulb' });
  });

  it('leaves a product name containing x alone', () => {
    // "Switch Board 6x4" is a size, not four of item 6.
    expect(parseQuantityPrefix('Switch Board 6x4', CATALOGUE)).toEqual({
      qty: 1,
      term: 'Switch Board 6x4',
    });
    expect(parseQuantityPrefix('5x20mm Fuse', CATALOGUE)).toEqual({ qty: 1, term: '5x20mm Fuse' });
  });

  it('still multiplies on an explicit asterisk when no code matches', () => {
    // Typing `3*bulb` is unambiguous intent even before the item is resolved.
    expect(parseQuantityPrefix('3*bulb', CATALOGUE)).toEqual({ qty: 3, term: 'bulb' });
  });

  it('works with no catalogue supplied, falling back to the leading number', () => {
    expect(parseQuantityPrefix('5*101')).toEqual({ qty: 5, term: '101' });
    expect(parseQuantityPrefix('Switch Board 6x4')).toEqual({ qty: 1, term: 'Switch Board 6x4' });
  });

  it('ignores a zero or negative quantity', () => {
    expect(parseQuantityPrefix('0*101', CATALOGUE)).toEqual({ qty: 1, term: '0*101' });
  });
});
