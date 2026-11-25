// Flags: --experimental-otel --no-warnings
'use strict';

const common = require('../common');
const assert = require('assert');
const otel = require('node:otel');

const { ROOT_CONTEXT, propagation, trace } = otel;
const noInstrumentations = { http: false, fetch: false };

function remoteParent(flags) {
  return propagation.extract(ROOT_CONTEXT, {
    traceparent: `00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-${flags}`,
  });
}

async function withSampler(options, fn) {
  const exporter = new otel.InMemorySpanExporter();
  otel.start({ exporter, instrumentations: noInstrumentations, ...options });
  try {
    fn(otel.getTracer('test'));
    await otel.flush();
    return exporter.getFinishedSpans();
  } finally {
    await otel.stop();
  }
}

async function run() {
  // always_off still produces valid, propagatable span contexts.
  let spans = await withSampler({ sampler: 'always_off' }, common.mustCall((tracer) => {
    const span = tracer.startSpan('dropped');
    assert.strictEqual(span.isRecording(), false);
    assert.strictEqual(trace.isSpanContextValid(span.spanContext()), true);
    assert.strictEqual(span.spanContext().traceFlags, 0);
    span.end();
  }));
  assert.strictEqual(spans.length, 0);

  // The default parent-based sampler follows the parent's sampled flag.
  spans = await withSampler({}, (tracer) => {
    tracer.startSpan('sampled-parent', {}, remoteParent('01')).end();
    tracer.startSpan('unsampled-parent', {}, remoteParent('00')).end();
    tracer.startSpan('no-parent').end();
  });
  assert.deepStrictEqual(spans.map((span) => span.name), ['sampled-parent', 'no-parent']);
  assert.strictEqual(spans[0].spanContext().traceId, '0af7651916cd43dd8448eb211c80319c');
  assert.strictEqual(spans[0].parentSpanContext.isRemote, true);

  // always_on ignores the parent's decision.
  spans = await withSampler({ sampler: 'always_on' }, (tracer) => {
    tracer.startSpan('unsampled-parent', {}, remoteParent('00')).end();
  });
  assert.strictEqual(spans.length, 1);

  // The traceidratio sampler decides on the trace ID, so the decision is deterministic.
  spans = await withSampler({ sampler: 'traceidratio', samplerArg: 0.5 }, (tracer) => {
    for (let i = 0; i < 1000; i++) tracer.startSpan(`${i}`).end();
  });
  assert(spans.length > 350 && spans.length < 650, `${spans.length}`);
  for (const span of spans) {
    const low56 = BigInt(`0x${span.spanContext().traceId.slice(18)}`);
    assert(low56 < 2n ** 55n);
  }

  // Invalid options throw; invalid environment variables fall back with a warning.
  assert.throws(() => otel.start({ sampler: 'sometimes' }), { code: 'ERR_INVALID_ARG_VALUE' });
  assert.throws(() => otel.start({ sampler: 'traceidratio', samplerArg: 2 }),
                { code: 'ERR_OUT_OF_RANGE' });

  process.env.OTEL_TRACES_SAMPLER = 'sometimes';
  process.on('warning', common.mustCall((warning) => {
    assert.strictEqual(warning.name, 'OpenTelemetryWarning');
    assert.match(warning.message, /OTEL_TRACES_SAMPLER/);
  }));
  spans = await withSampler({}, (tracer) => tracer.startSpan('fallback').end());
  assert.strictEqual(spans.length, 1);
}

run().then(common.mustCall());
