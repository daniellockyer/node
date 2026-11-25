// Measures the overhead of node:otel on HTTP server throughput. Spans are
// passed to an exporter that discards them, so only the SDK cost is measured.
'use strict';

const common = require('../common.js');

const bench = common.createBenchmark(main, {
  mode: ['off', 'loaded', 'started'],
  c: [50],
  duration: 5,
}, {
  flags: ['--experimental-otel', '--no-warnings'],
});

function main({ mode, c, duration }) {
  if (mode !== 'off') {
    const otel = require('node:otel');
    if (mode === 'started') {
      otel.start({ exporter: { export: () => Promise.resolve() } });
    }
  }

  const http = require('http');
  const server = http.createServer((req, res) => {
    res.end('hello world');
  });
  server.listen(0, () => {
    bench.http({
      path: '/',
      connections: c,
      duration,
      port: server.address().port,
    }, () => {
      server.close();
    });
  });
}
