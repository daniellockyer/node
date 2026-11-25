// Flags: --experimental-otel --no-warnings
'use strict';

const common = require('../common');
const assert = require('assert');
const otel = require('node:otel');

const { SpanStatusCode, trace } = otel;

// Before start(), spans do not record but still carry their parent's context.
{
  const tracer = otel.getTracer('early');
  const span = tracer.startSpan('unrecorded');
  assert.strictEqual(span.isRecording(), false);
  assert.strictEqual(trace.isSpanContextValid(span.spanContext()), false);
  assert.strictEqual(span.setAttribute('a', 1), span);
  span.end();
}

process.env.OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT = '3';
process.env.OTEL_SPAN_EVENT_COUNT_LIMIT = '2';
process.env.OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT = '4';

const exporter = new otel.InMemorySpanExporter();
otel.start({ exporter, instrumentations: { http: false, fetch: false } });
const tracer = otel.getTracer('test', '1.2.3', { schemaUrl: 'https://opentelemetry.io/schemas/1.26.0' });

async function run() {
  // Attributes are validated, truncated and limited.
  const span = tracer.startSpan('span', { attributes: { initial: true } });
  assert.strictEqual(span.isRecording(), true);
  assert.strictEqual(trace.isSpanContextValid(span.spanContext()), true);
  assert.match(span.spanContext().traceId, /^[0-9a-f]{32}$/);
  assert.match(span.spanContext().spanId, /^[0-9a-f]{16}$/);
  assert.strictEqual(span.spanContext().traceFlags, 1);
  span.setAttribute('object', {});
  span.setAttribute('mixed', [1, 'a']);
  span.setAttribute('', 1);
  span.setAttributes({ str: 'abcdef', list: ['abcdef', null, 'x'] });
  span.setAttribute('over', 1);
  span.setAttribute('str', 'xy');

  // Events honour their limit, and recordException() records an event.
  span.addEvent('first', { k: 'v' });
  span.recordException(Object.assign(new Error('bad'), { code: 'ERR_BAD' }), new Date(0));
  span.addEvent('dropped');

  // UNSET never overrides, ERROR can be replaced by OK, and OK is final.
  span.setStatus({ code: SpanStatusCode.ERROR, message: 'failed' });
  span.setStatus({ code: SpanStatusCode.UNSET });
  assert.deepStrictEqual({ ...span.status },
                         { code: SpanStatusCode.ERROR, message: 'failed' });
  span.setStatus({ code: SpanStatusCode.OK, message: 'ignored' });
  span.setStatus({ code: SpanStatusCode.ERROR });
  assert.strictEqual(span.status.code, SpanStatusCode.OK);
  assert.strictEqual(span.status.message, undefined);
  assert.throws(() => span.setStatus({ code: 7 }), { code: 'ERR_INVALID_ARG_VALUE' });

  span.updateName('renamed');
  span.end();
  assert.strictEqual(span.isRecording(), false);
  const { endTime } = span;
  span.end();
  span.setAttribute('late', 1);
  span.updateName('late');
  assert.strictEqual(span.endTime, endTime);

  assert.strictEqual(span.name, 'renamed');
  assert.deepStrictEqual({ ...span.attributes },
                         { initial: true, str: 'xy', list: ['abcd', null, 'x'] });
  assert.strictEqual(span.droppedAttributesCount, 1);
  assert.strictEqual(span.events.length, 2);
  assert.strictEqual(span.droppedEventsCount, 1);
  assert.deepStrictEqual({ ...span.events[0].attributes }, { k: 'v' });
  const exception = span.events[1];
  assert.strictEqual(exception.name, 'exception');
  assert.strictEqual(exception.time, 0n);
  // 'ERR_BAD', truncated to OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT.
  assert.strictEqual(exception.attributes['exception.type'], 'ERR_');
  assert.strictEqual(exception.attributes['exception.message'], 'bad');
  assert.strictEqual(typeof exception.attributes['exception.stacktrace'], 'string');
  assert.deepStrictEqual({ ...span.instrumentationScope }, {
    name: 'test',
    version: '1.2.3',
    schemaUrl: 'https://opentelemetry.io/schemas/1.26.0',
  });

  // Explicit timestamps are milliseconds since the epoch, and end times before
  // the start are clamped.
  const timed = tracer.startSpan('timed', { startTime: 1000 });
  timed.end(new Date(500));
  assert.strictEqual(timed.startTime, 1_000_000_000n);
  assert.strictEqual(timed.endTime, 1_000_000_000n);

  // Links reference other span contexts.
  const linked = tracer.startSpan('linked', {
    links: [{ context: span.spanContext(), attributes: { reason: 'batch' } }],
  });
  linked.end();
  assert.strictEqual(linked.links.length, 1);
  assert.strictEqual(linked.links[0].context, span.spanContext());
  assert.throws(() => tracer.startSpan('bad', { links: [{ context: {} }] }),
                { code: 'ERR_INVALID_ARG_TYPE' });
  assert.throws(() => tracer.startSpan('bad', { kind: 9 }),
                { code: 'ERR_INVALID_ARG_VALUE' });
  assert.throws(() => tracer.startSpan(1), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.throws(() => otel.getTracer(), { code: 'ERR_INVALID_ARG_TYPE' });

  await otel.flush();
  assert.deepStrictEqual(exporter.getFinishedSpans().map((s) => s.name),
                         ['renamed', 'timed', 'linked']);
  exporter.reset();
  await otel.stop();
}

run().then(common.mustCall());
