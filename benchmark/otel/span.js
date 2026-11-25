// Measures the cost of creating and ending spans.
'use strict';

const common = require('../common.js');

const bench = common.createBenchmark(main, {
  mode: ['unstarted', 'sampled', 'unsampled'],
  method: ['startSpan', 'startActiveSpan'],
  attributes: [0, 8],
  n: [1e5],
}, {
  flags: ['--experimental-otel', '--no-warnings'],
});

function main({ mode, method, attributes, n }) {
  const otel = require('node:otel');
  if (mode !== 'unstarted') {
    otel.start({
      exporter: { export: () => Promise.resolve() },
      sampler: mode === 'sampled' ? 'always_on' : 'always_off',
      instrumentations: { http: false, fetch: false },
    });
  }
  const tracer = otel.getTracer('bench');
  const options = { attributes: {} };
  for (let i = 0; i < attributes; i++) options.attributes[`key${i}`] = i;

  bench.start();
  if (method === 'startSpan') {
    for (let i = 0; i < n; i++) tracer.startSpan('span', options).end();
  } else {
    for (let i = 0; i < n; i++) {
      tracer.startActiveSpan('span', options, (span) => span.end());
    }
  }
  bench.end(n);
}
