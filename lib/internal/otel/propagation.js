'use strict';

const {
  ArrayIsArray,
  ArrayPrototypeJoin,
  NumberParseInt,
  RegExpPrototypeExec,
  StringPrototypePadStart,
  StringPrototypeTrim,
} = primordials;

const {
  getSpan,
  setSpan,
  validateContext,
} = require('internal/otel/context');
const { isValidSpanId, isValidTraceId } = require('internal/otel/ids');
const {
  NonRecordingSpan,
  createSpanContext,
  isSpanContextValid,
} = require('internal/otel/span');
const {
  kValidateObjectAllowFunction,
  validateObject,
} = require('internal/validators');

const kTraceParent = 'traceparent';
const kTraceState = 'tracestate';
const kMaxTraceStateLength = 512;

// version-traceid-parentid-flags. Versions after 00 may append fields, and
// version ff is invalid.
const kTraceParentRegExp =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;

function parseTraceParent(header) {
  const match = RegExpPrototypeExec(kTraceParentRegExp, StringPrototypeTrim(header));
  if (match === null) return undefined;
  const { 1: version, 2: traceId, 3: spanId, 4: flags, 5: rest } = match;
  if (version === 'ff' || (version === '00' && rest !== undefined)) {
    return undefined;
  }
  if (!isValidTraceId(traceId) || !isValidSpanId(spanId)) return undefined;
  return { traceId, spanId, traceFlags: NumberParseInt(flags, 16) & 0x01 };
}

function getHeader(carrier, name) {
  const value = typeof carrier.get === 'function' ?
    carrier.get(name) : carrier[name];
  if (ArrayIsArray(value)) return ArrayPrototypeJoin(value, ',');
  return typeof value === 'string' ? value : undefined;
}

function setHeader(carrier, name, value) {
  if (typeof carrier.set === 'function') {
    carrier.set(name, value);
  } else {
    carrier[name] = value;
  }
}

function formatTraceParent(spanContext) {
  const flags = StringPrototypePadStart((spanContext.traceFlags & 0xff).toString(16), 2, '0');
  return `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
}

// Writes the W3C trace context of the context's span into a carrier. Carriers
// with a set() method, such as Headers, are written through it; anything else
// is treated as a plain headers object.
function inject(context, carrier) {
  validateContext(context, 'context');
  validateObject(carrier, 'carrier', kValidateObjectAllowFunction);
  const spanContext = getSpan(context)?.spanContext();
  if (!isSpanContextValid(spanContext)) return;
  setHeader(carrier, kTraceParent, formatTraceParent(spanContext));
  if (spanContext.traceState !== undefined) {
    setHeader(carrier, kTraceState, spanContext.traceState);
  }
}

// Returns a copy of the context whose span is the remote parent described by
// the carrier's W3C trace context headers, or the context unchanged if they are
// missing or invalid. Header names are looked up in lowercase.
function extract(context, carrier) {
  validateContext(context, 'context');
  validateObject(carrier, 'carrier', kValidateObjectAllowFunction);
  const traceParent = getHeader(carrier, kTraceParent);
  if (traceParent === undefined) return context;
  const parsed = parseTraceParent(traceParent);
  if (parsed === undefined) return context;
  let traceState = getHeader(carrier, kTraceState);
  if (traceState !== undefined) {
    traceState = StringPrototypeTrim(traceState);
    if (traceState === '' || traceState.length > kMaxTraceStateLength) {
      traceState = undefined;
    }
  }
  const spanContext = createSpanContext(
    parsed.traceId, parsed.spanId, parsed.traceFlags, traceState, true);
  return setSpan(context, new NonRecordingSpan(spanContext));
}

module.exports = {
  extract,
  inject,
};
