/**
 * What makes an acceptable PIN, and how hard it is to guess at.
 *
 * Here rather than beside the hashing because two places now set PINs: the
 * counter, when the owner adds a cashier, and the website, when they do it
 * from a phone. If the rules differed, a PIN chosen on one could be refused by
 * the other — or worse, a PIN the counter would have rejected as too easy
 * could be let through from away from the shop, and nobody would know until
 * someone guessed it.
 *
 * The hashing itself is not here. It needs a native library, and this package
 * is imported by a browser; each end calls Argon2id with the parameters below.
 * Those parameters are written into the hash string itself, so a PIN set in one
 * place verifies in the other regardless — keeping them together is about the
 * cost staying deliberate, not about compatibility.
 */

export const PIN_LENGTH = 4;

/**
 * Argon2id, tuned so one check takes roughly a tenth of a second on
 * shop-grade hardware.
 *
 * Unnoticeable to a cashier signing in, and ruinous for anyone working through
 * all ten thousand four-digit PINs. A four-digit secret is weak on its own;
 * this and the lockout after repeated failures are what stand behind it.
 */
export const PIN_HASH_COST = {
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export function isValidPin(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);
}

/**
 * Why this PIN will not do, in words the person choosing it can act on.
 *
 * Null when it is fine. Deliberately a short list: refusing half the possible
 * PINs would push people towards writing them down, which is worse than
 * letting someone choose 1357.
 */
export function pinWeakness(pin: string): string | null {
  if (!isValidPin(pin)) return `The PIN must be exactly ${PIN_LENGTH} digits.`;
  if (/^(\d)\1+$/.test(pin)) return 'Choose a PIN that is not the same digit repeated.';
  if (pin === '1234' || pin === '0000' || pin === '4321') {
    return 'That PIN is too easy to guess. Choose another.';
  }
  return null;
}
