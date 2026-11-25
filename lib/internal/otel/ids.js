'use strict';

const {
  MathFloor,
  MathRandom,
  RegExpPrototypeExec,
  StringPrototypeRepeat,
} = primordials;

const { Buffer } = require('buffer');

const kPoolSize = 4096;
const kInvalidTraceId = StringPrototypeRepeat('0', 32);
const kInvalidSpanId = StringPrototypeRepeat('0', 16);
const kTraceIdRegExp = /^[0-9a-f]{32}$/;
const kSpanIdRegExp = /^[0-9a-f]{16}$/;

let pool;
let poolOffset = kPoolSize;
let randomFillSync;

function fillPool() {
  pool ??= Buffer.allocUnsafeSlow(kPoolSize);
  if (process.versions.openssl) {
    randomFillSync ??= require('internal/crypto/random').randomFillSync;
    randomFillSync(pool);
  } else {
    for (let i = 0; i < kPoolSize; i++) {
      pool[i] = MathFloor(MathRandom() * 256);
    }
  }
  poolOffset = 0;
}

function randomHex(byteLength) {
  if (poolOffset + byteLength > kPoolSize) fillPool();
  const hex = pool.hexSlice(poolOffset, poolOffset + byteLength);
  poolOffset += byteLength;
  return hex;
}

function generateTraceId() {
  let id;
  do {
    id = randomHex(16);
  } while (id === kInvalidTraceId);
  return id;
}

function generateSpanId() {
  let id;
  do {
    id = randomHex(8);
  } while (id === kInvalidSpanId);
  return id;
}

function isValidTraceId(id) {
  return typeof id === 'string' && id !== kInvalidTraceId &&
    RegExpPrototypeExec(kTraceIdRegExp, id) !== null;
}

function isValidSpanId(id) {
  return typeof id === 'string' && id !== kInvalidSpanId &&
    RegExpPrototypeExec(kSpanIdRegExp, id) !== null;
}

module.exports = {
  kInvalidSpanId,
  kInvalidTraceId,
  generateSpanId,
  generateTraceId,
  isValidSpanId,
  isValidTraceId,
};
