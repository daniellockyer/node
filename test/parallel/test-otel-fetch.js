// Flags: --experimental-otel --no-warnings
'use strict';

const common = require('../common');
const assert = require('assert');
const http = require('http');
const { once } = require('events');
const otel = require('node:otel');

const { SpanKind, SpanStatusCode } = otel;

const exporter = new otel.InMemorySpanExporter();
otel.start({ exporter, instrumentations: { http: false } });
const tracer = otel.getTracer('test');

const received = [];
const server = http.createServer((req, res) => {
  received.push(req.headers.traceparent);
  res.statusCode = req.url === '/missing' ? 404 : 200;
  res.end('ok');
});

async function run() {
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();

  await tracer.startActiveSpan('root', common.mustCall(async (root) => {
    const res = await fetch(`http://127.0.0.1:${port}/path?q=1`, { method: 'POST', body: 'x' });
    assert.strictEqual(await res.text(), 'ok');
    const missing = await fetch(`http://127.0.0.1:${port}/missing`);
    await missing.text();
    root.end();
  }));
  await otel.flush();

  const spans = exporter.getFinishedSpans();
  const root = spans.find((span) => span.name === 'root');
  const post = spans.find((span) => span.name === 'POST');
  const get = spans.find((span) => span.name === 'GET');

  assert.strictEqual(post.kind, SpanKind.CLIENT);
  assert.strictEqual(post.instrumentationScope.name, 'node:fetch');
  assert.strictEqual(post.spanContext().traceId, root.spanContext().traceId);
  assert.strictEqual(post.parentSpanContext.spanId, root.spanContext().spanId);
  assert.deepStrictEqual({ ...post.attributes }, {
    'http.request.method': 'POST',
    'server.address': '127.0.0.1',
    'server.port': port,
    'url.full': `http://127.0.0.1:${port}/path?q=1`,
    'http.response.status_code': 200,
  });
  assert.strictEqual(post.status.code, SpanStatusCode.UNSET);
  assert.strictEqual(get.status.code, SpanStatusCode.ERROR);
  assert.strictEqual(get.attributes['error.type'], '404');

  // The server received each client span's context.
  assert.deepStrictEqual(received, [
    `00-${post.spanContext().traceId}-${post.spanContext().spanId}-01`,
    `00-${get.spanContext().traceId}-${get.spanContext().spanId}-01`,
  ]);
  exporter.reset();

  // A caller-supplied traceparent is left alone.
  const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
  await (await fetch(`http://127.0.0.1:${port}/`, { headers: { traceparent } })).text();
  assert.strictEqual(received.at(-1), traceparent);

  // Connection failures are recorded on the span. Use a port that has never
  // been connected to, so no pooled keep-alive socket is reused.
  server.close();
  server.closeAllConnections();
  await once(server, 'close');
  const unused = http.createServer();
  unused.listen(0);
  await once(unused, 'listening');
  const unusedPort = unused.address().port;
  unused.close();
  await once(unused, 'close');
  await assert.rejects(fetch(`http://127.0.0.1:${unusedPort}/`), TypeError);
  await otel.flush();
  const failed = exporter.getFinishedSpans().find((span) => span.status.code === SpanStatusCode.ERROR);
  assert.strictEqual(failed.attributes['error.type'], 'ECONNREFUSED');
  assert.strictEqual(failed.events[0].name, 'exception');

  await otel.stop();
}

run().then(common.mustCall());
