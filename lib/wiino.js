'use strict';

// Wii Number (NWC24 user ID) validation, after RiiConnect24/wiino. A real
// number is a scrambled 53-bit value carrying a 10-bit CRC, so mistyped or
// invented numbers fail the check and never reach WiiConnect24.

const MASK53 = 0x001FFFFFFFFFFFFFn;
const TABLE2 = [0x1, 0x5, 0x0, 0x4, 0x2, 0x3, 0x6, 0x7];
const TABLE1_INV = [0xD, 0x5, 0x9, 0x7, 0x0, 0xF, 0xA, 0x2, 0xC, 0x3, 0xE, 0x1, 0x8, 0x6, 0xB, 0x4];

const getByte = (v, i) => Number((v >> BigInt(i * 8)) & 0xFFn);
const putByte = (v, i, b) => (v & ~(0xFFn << BigInt(i * 8))) | (BigInt(b) << BigInt(i * 8));

function crcReduce(id) {
  for (let i = 0; i <= 42; i++) {
    if ((id >> BigInt(52 - i)) & 1n) id ^= 0x635n << BigInt(42 - i);
  }
  return id;
}

function unscramble(id) {
  id &= MASK53;
  id ^= 0x5E5E5E5E5E5En;
  id &= MASK53;

  id |= ((id << 5n) & 0x20n) << 48n;
  id >>= 1n;

  const copy = id;
  for (let i = 0; i <= 5; i++) id = putByte(id, i, getByte(copy, TABLE2[i]));
  for (let i = 0; i <= 5; i++) {
    const b = getByte(id, i);
    id = putByte(id, i, (TABLE1_INV[b >> 4] << 4) | TABLE1_INV[b & 0xF]);
  }

  const hi = id >> 32n;
  const a = (id >> 0x16n) | ((hi & 0x7FFn) << 10n);
  const b = ((id * 0x400n) & 0xFFFFFFFFn) | ((hi >> 0xBn) & 0x3FFn);
  return ((((a << 32n) | b) ^ 0xB3B3B3B3B3B3n)) & MASK53;
}

/** True when `digits` is a 16-digit Wii Number with a valid checksum. */
function isValidWiiNumber(digits) {
  if (!/^\d{16}$/.test(String(digits || ''))) return false;
  const id = BigInt(digits);
  if (id === 0n || id > MASK53) return false;
  const d = unscramble(id);
  if (crcReduce(d) !== 0n) return false;
  const hardware = Number((d >> 47n) & 7n);
  const area = Number((d >> 50n) & 7n);
  return hardware <= 2 && area <= 6;
}

module.exports = { isValidWiiNumber };
