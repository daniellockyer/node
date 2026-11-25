// Flags: --experimental-otel --no-warnings
'use strict';

const common = require('../common');
const assert = require('assert');
const otel = require('node:otel');

const { context, trace, ROOT_CONTEXT, createContextKey } = otel;

// Contexts are immutable maps.
{
  const key = createContextKey('key');
  assert.strictEqual(typeof key, 'symbol');
  const ctx = ROOT_CONTEXT.setValue(key, 1);
  assert.notStrictEqual(ctx, ROOT_CONTEXT);
  assert.strictEqual(ROOT_CONTEXT.getValue(key), undefined);
  assert.strictEqual(ctx.getValue(key), 1);
  assert.strictEqual(ctx.deleteValue(key).getValue(key), undefined);
  assert.strictEqual(ROOT_CONTEXT.deleteValue(key), ROOT_CONTEXT);
}

// context.with() and context.bind() set the active context.
{
  const key = createContextKey('key');
  const ctx = ROOT_CONTEXT.setValue(key, 'value');
  assert.strictEqual(context.active(), ROOT_CONTEXT);

  const thisArg = {};
  const result = context.with(ctx, common.mustCall(function(a, b) {
    assert.strictEqual(this, thisArg);
    assert.strictEqual(context.active(), ctx);
    return a + b;
  }), thisArg, 1, 2);
  assert.strictEqual(result, 3);
  assert.strictEqual(context.active(), ROOT_CONTEXT);

  const bound = context.bind(ctx, () => context.active().getValue(key));
  assert.strictEqual(bound(), 'value');

  for (const invalid of [null, {}, 'ctx']) {
    assert.throws(() => context.with(invalid, () => {}),
                  { code: 'ERR_INVALID_ARG_TYPE' });
    assert.throws(() => context.bind(invalid, () => {}),
                  { code: 'ERR_INVALID_ARG_TYPE' });
  }
  assert.throws(() => context.with(ctx, null), { code: 'ERR_INVALID_ARG_TYPE' });
}

// Active spans propagate through await, timers and setImmediate.
const exporter = new otel.InMemorySpanExporter();
otel.start({ exporter, instrumentations: { http: false, fetch: false } });
const tracer = otel.getTracer('test');

async function run() {
  await tracer.startActiveSpan('parent', common.mustCall(async (parent) => {
    assert.strictEqual(trace.getActiveSpan(), parent);
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.strictEqual(trace.getActiveSpan(), parent);
    await new Promise((resolve) => setImmediate(common.mustCall(() => {
      tracer.startSpan('immediate').end();
      resolve();
    })));
    tracer.startActiveSpan('nested', { kind: otel.SpanKind.CLIENT }, common.mustCall((nested) => {
      assert.strictEqual(trace.getActiveSpan(), nested);
      tracer.startSpan('grandchild').end();
      nested.end();
    }));
    assert.strictEqual(trace.getActiveSpan(), parent);
    tracer.startSpan('root', { root: true }).end();
    parent.end();
  }));
  assert.strictEqual(trace.getActiveSpan(), undefined);

  // An explicit context overrides the active one.
  const detached = tracer.startSpan('detached');
  tracer.startActiveSpan('other', (other) => {
    tracer.startSpan('explicit', {}, trace.setSpan(ROOT_CONTEXT, detached)).end();
    other.end();
  });
  detached.end();

  await otel.flush();
  const spans = new Map(exporter.getFinishedSpans().map((span) => [span.name, span]));
  const parent = spans.get('parent');
  const { traceId, spanId } = parent.spanContext();
  assert.strictEqual(parent.parentSpanContext, undefined);
  for (const name of ['immediate', 'nested']) {
    assert.strictEqual(spans.get(name).spanContext().traceId, traceId);
    assert.strictEqual(spans.get(name).parentSpanContext.spanId, spanId);
  }
  assert.strictEqual(spans.get('nested').kind, otel.SpanKind.CLIENT);
  assert.strictEqual(spans.get('grandchild').parentSpanContext.spanId,
                     spans.get('nested').spanContext().spanId);
  assert.strictEqual(spans.get('root').parentSpanContext, undefined);
  assert.notStrictEqual(spans.get('root').spanContext().traceId, traceId);
  assert.strictEqual(spans.get('explicit').parentSpanContext.spanId,
                     detached.spanContext().spanId);

  assert.throws(() => tracer.startActiveSpan('x'), { code: 'ERR_INVALID_ARG_TYPE' });
  await otel.stop();
}

run().then(common.mustCall());
