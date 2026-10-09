/**
 * UUIDv7 primary keys.
 *
 * Every row in this system gets a client-generated UUID rather than an
 * autoincrement integer. The shop runs on one PC today, but the moment a second
 * terminal or the website can create a row, integer IDs collide — and repainting
 * primary keys across a live ledger is not a migration anyone wants to write.
 *
 * v7 rather than v4 because the first 48 bits are a millisecond timestamp, so
 * IDs sort chronologically and B-tree indexes stay dense instead of fragmenting
 * on random inserts.
 */

const HEX: string[] = [];
for (let i = 0; i < 256; i++) HEX.push(i.toString(16).padStart(2, '0'));

/**
 * Minimal shape of the Web Crypto API.
 *
 * Declared locally rather than pulling in the DOM or Node type libraries: this
 * package is shared by the Electron main process, the renderer and the website,
 * so it must not assume any one environment's globals.
 */
interface WebCryptoLike {
  getRandomValues(array: Uint8Array): Uint8Array;
}

function webCrypto(): WebCryptoLike {
  const found = (globalThis as { crypto?: WebCryptoLike }).crypto;
  if (!found?.getRandomValues) {
    throw new Error('Web Crypto is unavailable; cannot generate identifiers safely.');
  }
  return found;
}

/** Generate a UUIDv7. */
export function uuidv7(): string {
  const bytes = new Uint8Array(16);
  webCrypto().getRandomValues(bytes);

  // 48-bit big-endian millisecond timestamp
  const ts = Date.now();
  bytes[0] = Math.floor(ts / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ts / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ts / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ts / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;

  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant

  return (
    HEX[bytes[0]!]! + HEX[bytes[1]!]! + HEX[bytes[2]!]! + HEX[bytes[3]!]! + '-' +
    HEX[bytes[4]!]! + HEX[bytes[5]!]! + '-' +
    HEX[bytes[6]!]! + HEX[bytes[7]!]! + '-' +
    HEX[bytes[8]!]! + HEX[bytes[9]!]! + '-' +
    HEX[bytes[10]!]! + HEX[bytes[11]!]! + HEX[bytes[12]!]! +
    HEX[bytes[13]!]! + HEX[bytes[14]!]! + HEX[bytes[15]!]!
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Extract the creation time embedded in a v7 UUID. Handy for debugging sync. */
export function uuidv7Timestamp(uuid: string): Date | null {
  if (!isUuid(uuid)) return null;
  const hex = uuid.replace(/-/g, '').slice(0, 12);
  return new Date(parseInt(hex, 16));
}
