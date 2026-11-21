/**
 * Time-sortable ids with a type prefix (`sub_`, `grt_`, `ovr_`, `rsv_`, `act_`):
 * 10 chars of millisecond timestamp + 12 random chars, Crockford base32. Zero
 * dependencies (Web Crypto).
 *
 * @module
 */

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** A new id: `prefix` + `_` + 22 lowercase base32 chars (sorts by creation time). */
export function newId(prefix: string, now: number = Date.now()): string {
  let time = "";
  let t = Math.max(0, Math.floor(now));
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let rand = "";
  for (const b of bytes) rand += ALPHABET[b % 32];
  return `${prefix}_${time}${rand}`;
}
