// Flags: --experimental-otel --no-warnings
'use strict';

const common = require('../common');
const assert = require('assert');
const otel = require('node:otel');

const noInstrumentations = { http: false, fetch: false };

async function run() {
  // stop() and flush() are no-ops before start().
  await otel.stop();
  await otel.flush();

  // Options are validated before anything is started.
  for (const options of [
    null,
    { serviceName: 1 },
    { resource: 'resource' },
    { endpoint: 1 },
    { exporter: {} },
    { exporter: { export() {}, shutdown: 1 } },
    { instrumentations: { http: 'yes' } },
    { headers: { 'x-key': 1 } },
  ]) {
    assert.throws(() => otel.start(options), { code: 'ERR_INVALID_ARG_TYPE' });
  }
  for (const endpoint of ['not a url', 'ftp://example.com/v1/traces']) {
    assert.throws(() => otel.start({ endpoint }), { code: 'ERR_INVALID_ARG_VALUE' });
  }

  // Custom exporters receive batches with an abort signal, and are shut down
  // by stop().
  const batches = [];
  const exporter = {
    export: common.mustCall((spans, { signal }) => {
      assert(signal instanceof AbortSignal);
      batches.push(spans.map((span) => span.name));
      return Promise.resolve();
    }),
    shutdown: common.mustCall(),
  };
  otel.start({ exporter, instrumentations: noInstrumentations });
  assert.throws(() => otel.start({ exporter }), { code: 'ERR_INVALID_STATE' });
  const tracer = otel.getTracer('test');
  tracer.startSpan('first').end();
  tracer.startSpan('second').end();
  const unfinished = tracer.startSpan('unfinished');
  await otel.stop();
  assert.deepStrictEqual(batches, [['first', 'second']]);

  // Spans ended after stop() are discarded, and tracers created earlier stop
  // recording.
  unfinished.end();
  assert.strictEqual(tracer.startSpan('after-stop').isRecording(), false);

  // Tracing can be started again, and exporter failures surface as a single
  // warning rather than an exception.
  process.on('warning', common.mustCall((warning) => {
    assert.strictEqual(warning.name, 'OpenTelemetryWarning');
    assert.match(warning.message, /Failed to export spans: exporter failed/);
  }));
  const failing = {
    export: common.mustCall(() => { throw new Error('exporter failed'); }, 2),
  };
  otel.start({ exporter: failing, instrumentations: noInstrumentations });
  tracer.startSpan('fails').end();
  await otel.flush();
  tracer.startSpan('fails-again').end();
  await otel.flush();
  await otel.stop();
}

run().then(common.mustCall());
