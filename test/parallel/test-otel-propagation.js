// Flags: --experimental-otel --no-warnings
'use strict';

require('../common');
const assert = require('assert');
const otel = require('node:otel');

const { ROOT_CONTEXT, propagation, trace } = otel;

const traceId = '0af7651916cd43dd8448eb211c80319c';
const spanId = 'b7ad6b7169203331';

function extractSpanContext(headers) {
  return trace.getSpan(propagation.extract(ROOT_CONTEXT, headers))?.spanContext();
}

// Valid traceparent headers, including future versions with extra fields.
for (const [traceparent, traceFlags] of [
  [`00-${traceId}-${spanId}-01`, 1],
  [`00-${traceId}-${spanId}-00`, 0],
  [`00-${traceId}-${spanId}-03`, 1],
  [` 00-${traceId}-${spanId}-01 `, 1],
  [`cc-${traceId}-${spanId}-01-what-the-future-holds`, 1],
]) {
  assert.deepStrictEqual({ ...extractSpanContext({ traceparent }) }, {
    traceId,
    spanId,
    traceFlags,
    traceState: undefined,
    isRemote: true,
  }, traceparent);
}

// Invalid traceparent headers leave the context unchanged.
for (const traceparent of [
  `ff-${traceId}-${spanId}-01`,
  `00-${traceId}-${spanId}-01-extra`,
  `00-${'0'.repeat(32)}-${spanId}-01`,
  `00-${traceId}-${'0'.repeat(16)}-01`,
  `00-${traceId.toUpperCase()}-${spanId}-01`,
  `00-${traceId}-${spanId}`,
  `0-${traceId}-${spanId}-01`,
  '',
]) {
  assert.strictEqual(propagation.extract(ROOT_CONTEXT, { traceparent }), ROOT_CONTEXT,
                     traceparent);
}
assert.strictEqual(propagation.extract(ROOT_CONTEXT, {}), ROOT_CONTEXT);

// The tracestate header is carried through; repeated headers are joined, and oversized
// values are dropped.
assert.strictEqual(extractSpanContext({
  traceparent: `00-${traceId}-${spanId}-01`,
  tracestate: ['a=1', 'b=2'],
}).traceState, 'a=1,b=2');
assert.strictEqual(extractSpanContext({
  traceparent: `00-${traceId}-${spanId}-01`,
  tracestate: `a=${'x'.repeat(600)}`,
}).traceState, undefined);

// Headers objects are read and written through get() and set().
{
  const ctx = propagation.extract(ROOT_CONTEXT, new Headers({
    traceparent: `00-${traceId}-${spanId}-01`,
    tracestate: 'vendor=value',
  }));
  const headers = new Headers();
  propagation.inject(ctx, headers);
  assert.strictEqual(headers.get('traceparent'), `00-${traceId}-${spanId}-01`);
  assert.strictEqual(headers.get('tracestate'), 'vendor=value');
}

// Nothing is injected without a valid span context.
{
  const carrier = {};
  propagation.inject(ROOT_CONTEXT, carrier);
  assert.deepStrictEqual(carrier, {});
}

for (const carrier of [null, 'headers', 1]) {
  assert.throws(() => propagation.inject(ROOT_CONTEXT, carrier),
                { code: 'ERR_INVALID_ARG_TYPE' });
  assert.throws(() => propagation.extract(ROOT_CONTEXT, carrier),
                { code: 'ERR_INVALID_ARG_TYPE' });
}
assert.throws(() => propagation.extract({}, {}), { code: 'ERR_INVALID_ARG_TYPE' });
