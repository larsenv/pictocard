const test = require('node:test');
const assert = require('node:assert/strict');
const { isValidWiiNumber } = require('../lib/wiino');

// Numbers generated with RiiConnect24/wiino's NWC24MakeUserID.
const VALID = ['4206313713382912', '5889285544183596'];

test('real Wii Numbers pass the checksum', () => {
  for (const n of VALID) assert.equal(isValidWiiNumber(n), true);
});

test('mistyped, invented and malformed Wii Numbers are rejected', () => {
  for (const n of VALID) assert.equal(isValidWiiNumber(n.slice(0, 15) + ((Number(n[15]) + 1) % 10)), false);
  for (const n of ['1111222233334444', '5555666677778888', '0000000000000000', '123', '', 'abcd1234abcd1234', null]) {
    assert.equal(isValidWiiNumber(n), false);
  }
});
