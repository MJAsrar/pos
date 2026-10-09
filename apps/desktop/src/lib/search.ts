import type { Item } from './api';

/**
 * Item lookup at the counter.
 *
 * The whole catalogue sits in memory — a few thousand rows is nothing — so
 * every keystroke is scored locally with no round trip. That is the difference
 * between a list that is simply there as you type and one that stutters while a
 * customer waits.
 *
 * Matching has to survive how people actually type at a counter: half a word,
 * words in the wrong order, a missing space, a rough guess at the spelling.
 */

export interface ScoredItem {
  item: Item;
  score: number;
}

/** Drop punctuation and case so "USB-C" and "usb c" are the same query. */
function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * How well one item matches the query. Higher is better; 0 means no match.
 *
 * The tiers matter more than the exact numbers: an exact code has to beat
 * everything, because someone typing `101` wants item 101 and nothing else.
 */
function score(item: Item, query: string, tokens: string[]): number {
  const code = item.code.toLowerCase();
  const name = normalise(item.name);
  const haystack = `${code} ${name}`;

  if (code === query) return 1000;
  if (code.startsWith(query)) return 900 - code.length;

  let total = 0;

  for (const token of tokens) {
    let best = 0;

    if (name.startsWith(token)) {
      best = 120;
    } else if (new RegExp(`\\b${escapeRegExp(token)}`).test(name)) {
      // Start of any word: "bulb" finding "LED Bulb 12W".
      best = 100;
    } else if (haystack.includes(token)) {
      best = 60;
    } else if (isSubsequence(token, name)) {
      // Last resort, so "ledbulb" and mistyped words still find something.
      best = 25;
    }

    if (best === 0) return 0; // every token must match somewhere
    total += best;
  }

  // Prefer shorter names when scores tie: "LED Bulb 7W" over
  // "LED Bulb 7W Warm White Pack of 10".
  return total * 10 - Math.min(name.length, 60);
}

export function searchItems(items: readonly Item[], rawQuery: string, limit = 40): ScoredItem[] {
  const query = normalise(rawQuery);
  if (!query) return [];

  const tokens = query.split(' ').filter(Boolean);
  const results: ScoredItem[] = [];

  for (const item of items) {
    const value = score(item, query, tokens);
    if (value > 0) results.push({ item, score: value });
  }

  results.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
  return results.slice(0, limit);
}

/** An exact code match, for Enter-to-add without opening the search list. */
export function findByExactCode(items: readonly Item[], rawQuery: string): Item | null {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return null;
  return items.find((item) => item.code.toLowerCase() === query) ?? null;
}

export interface ParsedEntry {
  qty: number;
  term: string;
}

/**
 * Read a quantity out of what was typed.
 *
 * `5*101` and `101*5` both mean five of item 101 — one keystroke run instead of
 * adding the line and then editing its quantity.
 *
 * Which side is the quantity is genuinely ambiguous when codes are numbers, so
 * this resolves it against the catalogue: whichever side is a real item code is
 * the item. It also has to leave product names alone — "Switch Board 6x4" and
 * "5x20mm Fuse" are names, not arithmetic — so a bare `x` only counts as a
 * multiplier when the other side really is an item code.
 */
export function parseQuantityPrefix(raw: string, items: readonly Item[] = []): ParsedEntry {
  const input = raw.trim();
  const whole: ParsedEntry = { qty: 1, term: input };

  const match = /^(.+?)\s*([*x])\s*(.+)$/i.exec(input);
  if (!match) return whole;

  const [, left, separator, right] = match as unknown as [string, string, string, string];
  const explicit = separator === '*';

  const leftQty = asQuantity(left);
  const rightQty = asQuantity(right);
  const leftIsCode = isKnownCode(items, left);
  const rightIsCode = isKnownCode(items, right);

  // A known code on one side settles which is which, whichever separator was
  // used — but only if the other side is a usable quantity. `0*101` is a typo,
  // not an instruction to sell 101 of item 0.
  if (rightIsCode && !leftIsCode) return leftQty !== null ? { qty: leftQty, term: right.trim() } : whole;
  if (leftIsCode && !rightIsCode) return rightQty !== null ? { qty: rightQty, term: left.trim() } : whole;

  // No code matched. Only an explicit `*` is intent; `x` is part of a name.
  if (!explicit) return whole;
  if (leftQty !== null) return { qty: leftQty, term: right.trim() };
  if (rightQty !== null) return { qty: rightQty, term: left.trim() };

  return whole;
}

function asQuantity(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return parsed > 0 ? parsed : null;
}

function isKnownCode(items: readonly Item[], value: string): boolean {
  const needle = value.trim().toLowerCase();
  if (!needle) return false;
  return items.some((item) => item.code.toLowerCase() === needle);
}

function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) index++;
    if (index === needle.length) return true;
  }
  return needle.length === 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
