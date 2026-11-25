// Flags: --experimental-otel --no-warnings
'use strict';

const common = require('../common');
const assert = require('assert');
const http = require('http');
const { once } = require('events');
const { setTimeout: delay } = require('timers/promises');
const otel = require('node:otel');

const { SpanKind, SpanStatusCode, trace } = otel;

const exporter = new otel.InMemorySpanExporter();
otel.start({ exporter, instrumentations: { fetch: false } });
const tracer = otel.getTracer('test');

const remoteTraceId = '0af7651916cd43dd8448eb211c80319c';

let tracing = true;

const server = http.createServer(common.mustCall((req, res) => {
  // Request listeners run within the server span.
  const serverSpan = trace.getActiveSpan();
  assert.strictEqual(serverSpan?.kind, tracing ? SpanKind.SERVER : undefined);
  setTimeout(common.mustCall(() => {
    assert.strictEqual(trace.getActiveSpan(), serverSpan);
    tracer.startSpan('handler').end();
    if (req.url === '/destroy') {
      res.destroy();
      return;
    }
    res.statusCode = req.url === '/error' ? 500 : 200;
    res.end('ok');
  }), 1);
}, 5));

function get(path, options = {}) {
  return new Promise((resolve, reject) => {
    http.get({ port: server.address().port, path, ...options }, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    }).on('error', reject);
  });
}

function byName(name) {
  return exporter.getFinishedSpans().filter((span) => span.name === name);
}

async function run() {
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();

  // A client request inside an active span produces a client span that is the
  // remote parent of the server span.
  await tracer.startActiveSpan('root', async (root) => {
    await get('/path?query=1', { headers: { 'user-agent': 'test-agent' } });
    root.end();
  });
  await delay(10);
  await otel.flush();

  const [root] = byName('root');
  const client = byName('GET').find((span) => span.kind === SpanKind.CLIENT);
  const server1 = byName('GET').find((span) => span.kind === SpanKind.SERVER);
  const [handler] = byName('handler');
  const { traceId } = root.spanContext();
  for (const span of [client, server1, handler]) {
    assert.strictEqual(span.spanContext().traceId, traceId);
  }
  assert.strictEqual(client.parentSpanContext.spanId, root.spanContext().spanId);
  assert.strictEqual(server1.parentSpanContext.spanId, client.spanContext().spanId);
  assert.strictEqual(server1.parentSpanContext.isRemote, true);
  assert.strictEqual(handler.parentSpanContext.spanId, server1.spanContext().spanId);
  assert(client.endTime >= server1.endTime);

  assert.deepStrictEqual({ ...client.attributes }, {
    'http.request.method': 'GET',
    'server.address': 'localhost',
    'server.port': port,
    'url.full': `http://localhost:${port}/path?query=1`,
    'network.protocol.version': '1.1',
    'http.response.status_code': 200,
  });
  assert.strictEqual(server1.attributes['url.path'], '/path');
  assert.strictEqual(server1.attributes['url.query'], 'query=1');
  assert.strictEqual(server1.attributes['url.scheme'], 'http');
  assert.strictEqual(server1.attributes['server.port'], port);
  assert.strictEqual(server1.attributes['user_agent.original'], 'test-agent');
  assert.strictEqual(server1.attributes['http.response.status_code'], 200);
  assert.strictEqual(typeof server1.attributes['network.peer.port'], 'number');
  assert.strictEqual(server1.status.code, SpanStatusCode.UNSET);
  exporter.reset();

  // Incoming trace context is continued, and 5xx responses mark the server
  // span as failed.
  await get('/error', {
    headers: { traceparent: `00-${remoteTraceId}-b7ad6b7169203331-01` },
  });
  await delay(10);
  await otel.flush();
  {
    const spans = byName('GET');
    const serverSpan = spans.find((span) => span.kind === SpanKind.SERVER);
    const clientSpan = spans.find((span) => span.kind === SpanKind.CLIENT);
    // The user-supplied header is replaced with the client span's context.
    assert.strictEqual(serverSpan.parentSpanContext.spanId,
                       clientSpan.spanContext().spanId);
    assert.strictEqual(serverSpan.status.code, SpanStatusCode.ERROR);
    assert.strictEqual(serverSpan.attributes['error.type'], '500');
    assert.strictEqual(clientSpan.status.code, SpanStatusCode.ERROR);
  }
  exporter.reset();

  // Without an active span, the server continues the remote trace.
  await new Promise((resolve, reject) => {
    const req = http.request({
      port,
      method: 'purge',
      path: '/',
      headers: { traceparent: `00-${remoteTraceId}-b7ad6b7169203331-01` },
    }, (res) => res.resume().on('end', resolve));
    req.on('error', reject);
    req.end();
  });
  await delay(10);
  await otel.flush();
  {
    const [serverSpan] = byName('HTTP').filter((span) => span.kind === SpanKind.SERVER);
    assert.strictEqual(serverSpan.spanContext().traceId,
                       byName('HTTP').find((s) => s.kind === SpanKind.CLIENT).spanContext().traceId);
    assert.strictEqual(serverSpan.attributes['http.request.method'], '_OTHER');
    assert.strictEqual(serverSpan.attributes['http.request.method_original'], 'PURGE');
  }
  exporter.reset();

  // Responses destroyed before finishing still end the server span, and client
  // errors are recorded.
  await assert.rejects(get('/destroy'), { code: 'ECONNRESET' });
  await delay(10);
  await otel.flush();
  {
    const spans = byName('GET');
    const serverSpan = spans.find((span) => span.kind === SpanKind.SERVER);
    const clientSpan = spans.find((span) => span.kind === SpanKind.CLIENT);
    assert(serverSpan.ended);
    assert.strictEqual(serverSpan.attributes['http.response.status_code'], undefined);
    assert.strictEqual(clientSpan.status.code, SpanStatusCode.ERROR);
    assert.strictEqual(clientSpan.attributes['error.type'], 'ECONNRESET');
    assert.strictEqual(clientSpan.events[0].name, 'exception');
  }
  exporter.reset();

  // After stop(), nothing is instrumented.
  await otel.stop();
  tracing = false;
  const res = await get('/');
  assert.strictEqual(res.req.getHeader('traceparent'), undefined);
  assert.strictEqual(exporter.getFinishedSpans().length, 0);

  server.close();
}

run().then(common.mustCall());
