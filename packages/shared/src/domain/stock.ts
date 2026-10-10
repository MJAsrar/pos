/**
 * Turning a count into a movement.
 *
 * The one rule the whole stock design rests on: a quantity is never assigned,
 * only moved. "There are 50 on the shelf" has to become "add 12 to the 38 we
 * thought there were", because by the time that reaches the other side the
 * counter may have sold three more — and those three must still be gone
 * afterwards. Movements add up in any order; an absolute figure overwrites
 * whatever it finds.
 *
 * Lives here because both ends do it now: the counter when someone counts a
 * shelf, and the website when the owner corrects a figure from their phone.
 */

/** Quantities are rounded to three places, because wire sells by the metre. */
export function roundQty(qty: number): number {
  return Math.round(qty * 1000) / 1000;
}

export interface CountOutcome {
  /** The signed movement to record. Zero when nothing needs to change. */
  delta: number;
  /** What the figure should come to, for the trail. */
  qtyAfter: number;
  /** Nothing to do: the count already matches the record. */
  unchanged: boolean;
}

export function countToMovement(countedQty: number, currentQty: number): CountOutcome {
  const counted = roundQty(countedQty);
  const delta = roundQty(counted - roundQty(currentQty));
  return { delta, qtyAfter: counted, unchanged: delta === 0 };
}

/**
 * Whether an item has stopped moving.
 *
 * The case worth stating: an item that has *never* sold is not moving either.
 * Reading that as "no sale date, so nothing to compare, so leave it out" hides
 * exactly the stock the owner most wants to find — the box that was bought
 * once and has sat there since.
 */
export function isNotMoving(
  lastSoldAt: string | null,
  days: number,
  now: Date = new Date(),
): boolean {
  if (!lastSoldAt) return true;
  const sold = Date.parse(lastSoldAt);
  if (!Number.isFinite(sold)) return true;
  return sold < now.getTime() - days * 86_400_000;
}

/** How long since it last sold, or null if it never has. */
export function daysSinceSale(lastSoldAt: string | null, now: Date = new Date()): number | null {
  if (!lastSoldAt) return null;
  const sold = Date.parse(lastSoldAt);
  if (!Number.isFinite(sold)) return null;
  return Math.floor((now.getTime() - sold) / 86_400_000);
}
