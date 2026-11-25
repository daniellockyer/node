'use strict';

const {
  BigInt,
  DateNow,
  DatePrototypeGetTime,
  MathRound,
} = primordials;

const {
  codes: {
    ERR_INVALID_ARG_TYPE,
  },
} = require('internal/errors');
const { isDate } = require('internal/util/types');
const { validateNumber } = require('internal/validators');

let anchorEpochNs;
let anchorHrtimeNs;

// Epoch nanoseconds, anchored to the wall clock once and advanced with the
// monotonic clock so that span durations are unaffected by clock adjustments.
function now() {
  if (anchorEpochNs === undefined) {
    anchorEpochNs = BigInt(DateNow()) * 1_000_000n;
    anchorHrtimeNs = process.hrtime.bigint();
    return anchorEpochNs;
  }
  return anchorEpochNs + (process.hrtime.bigint() - anchorHrtimeNs);
}

// Accepts a Date or milliseconds since the epoch.
function toTimestamp(value, name) {
  if (value === undefined) return now();
  if (isDate(value)) value = DatePrototypeGetTime(value);
  if (typeof value !== 'number') {
    throw new ERR_INVALID_ARG_TYPE(name, ['number', 'Date'], value);
  }
  validateNumber(value, name, 0);
  return BigInt(MathRound(value * 1e6));
}

module.exports = {
  now,
  toTimestamp,
};
