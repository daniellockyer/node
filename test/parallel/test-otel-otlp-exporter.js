'use strict';

const common = require('../common');
const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');

function attributes(list) {
  return Object.fromEntries(list.map(({ key, value }) => [key, value]));
}

const requests = [];
let nextStatus = 200;
const collector = http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => body += chunk);
  req.on('end', () => {
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    res.statusCode = nextStatus;
    res.end('{}');
  });
});

collector.listen(0, '127.0.0.1', common.mustCall(async () => {
  const { port } = collector.address();

  // Spans are encoded as OTLP/JSON and flushed before the process exits.
  {
    const child = await runChildAsync(port, {
      OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=secret%20value,x-other=1',
      OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment=test,service.name=from-attributes',
    }, `
      const otel = require('node:otel');
      otel.start({ serviceName: 'svc', headers: { 'x-other': '2' } });
      const tracer = otel.getTracer('scope', '1.0.0', { schemaUrl: 'https://example.com/schema' });
      tracer.startActiveSpan('parent', { kind: otel.SpanKind.SERVER }, (parent) => {
        const child = tracer.startSpan('child', {
          attributes: { int: 3, double: 1.5, bool: true, str: 's', list: ['a', 'b'] },
          startTime: 1000,
        });
        child.addEvent('event', { k: 'v' }, 1500);
        child.setStatus({ code: otel.SpanStatusCode.ERROR, message: 'boom' });
        child.end(2000);
        parent.end();
      });
    `);
    assert.strictEqual(child.status, 0, child.stderr);
    assert.strictEqual(requests.length, 1);
    const { url, headers, body } = requests.shift();
    assert.strictEqual(url, '/v1/traces');
    assert.strictEqual(headers['content-type'], 'application/json');
    assert.strictEqual(headers['x-api-key'], 'secret value');
    assert.strictEqual(headers['x-other'], '2');
    assert.strictEqual(headers.traceparent, undefined);

    assert.strictEqual(body.resourceSpans.length, 1);
    const { resource, scopeSpans } = body.resourceSpans[0];
    const resourceAttributes = attributes(resource.attributes);
    assert.deepStrictEqual(resourceAttributes['service.name'], { stringValue: 'svc' });
    assert.deepStrictEqual(resourceAttributes['deployment.environment'], { stringValue: 'test' });
    assert.deepStrictEqual(resourceAttributes['telemetry.sdk.language'], { stringValue: 'nodejs' });
    assert.deepStrictEqual(resourceAttributes['process.pid'].intValue, `${child.pid}`);

    assert.strictEqual(scopeSpans.length, 1);
    assert.deepStrictEqual(scopeSpans[0].scope, { name: 'scope', version: '1.0.0' });
    assert.strictEqual(scopeSpans[0].schemaUrl, 'https://example.com/schema');
    const [childSpan, parentSpan] = scopeSpans[0].spans;
    assert.strictEqual(parentSpan.name, 'parent');
    assert.strictEqual(parentSpan.kind, 2);
    assert.strictEqual(parentSpan.parentSpanId, undefined);
    assert.strictEqual(parentSpan.flags, 0x101);
    assert.match(parentSpan.traceId, /^[0-9a-f]{32}$/);

    assert.strictEqual(childSpan.name, 'child');
    assert.strictEqual(childSpan.kind, 1);
    assert.strictEqual(childSpan.traceId, parentSpan.traceId);
    assert.strictEqual(childSpan.parentSpanId, parentSpan.spanId);
    assert.strictEqual(childSpan.startTimeUnixNano, '1000000000');
    assert.strictEqual(childSpan.endTimeUnixNano, '2000000000');
    assert.deepStrictEqual(attributes(childSpan.attributes), {
      int: { intValue: '3' },
      double: { doubleValue: 1.5 },
      bool: { boolValue: true },
      str: { stringValue: 's' },
      list: { arrayValue: { values: [{ stringValue: 'a' }, { stringValue: 'b' }] } },
    });
    assert.deepStrictEqual(childSpan.events, [{
      timeUnixNano: '1500000000',
      name: 'event',
      attributes: [{ key: 'k', value: { stringValue: 'v' } }],
      droppedAttributesCount: 0,
    }]);
    assert.deepStrictEqual(childSpan.status, { code: 2, message: 'boom' });
  }

  // A signal-specific endpoint is used as-is, and remote parents are flagged.
  {
    const child = await runChildAsync(port, {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${port}/custom`,
    }, `
      const otel = require('node:otel');
      otel.start();
      const ctx = otel.propagation.extract(otel.ROOT_CONTEXT, {
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      });
      otel.getTracer('t').startSpan('remote-child', {}, ctx).end();
    `);
    assert.strictEqual(child.status, 0, child.stderr);
    const { url, body } = requests.shift();
    assert.strictEqual(url, '/custom');
    const [span] = body.resourceSpans[0].scopeSpans[0].spans;
    assert.strictEqual(span.traceId, '0af7651916cd43dd8448eb211c80319c');
    assert.strictEqual(span.parentSpanId, 'b7ad6b7169203331');
    assert.strictEqual(span.flags, 0x301);
  }

  // Export failures are reported once as a warning and do not affect the exit code.
  {
    nextStatus = 503;
    const child = await runChildAsync(port, {}, `
      process.on('warning', (warning) => console.log(warning.name, warning.message));
      const otel = require('node:otel');
      otel.start();
      otel.getTracer('t').startSpan('lost').end();
    `);
    nextStatus = 200;
    assert.strictEqual(child.status, 0, child.stderr);
    assert.strictEqual(requests.length, 1);
    requests.shift();
    assert.match(child.stdout, /OpenTelemetryWarning Failed to export spans: OTLP endpoint responded with status 503/);
  }

  // Unsupported protocols fall back to http/json with a warning.
  {
    const child = await runChildAsync(port, {
      OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
    }, `
      process.on('warning', (warning) => console.log(warning.name, warning.message));
      const otel = require('node:otel');
      otel.start();
      otel.getTracer('t').startSpan('span').end();
    `);
    assert.strictEqual(child.status, 0, child.stderr);
    assert.strictEqual(requests.length, 1);
    requests.shift();
    assert.match(child.stdout, /OTLP protocol grpc is not supported; using http\/json/);
  }

  // OTEL_SDK_DISABLED turns start() into a no-op.
  {
    const child = await runChildAsync(port, { OTEL_SDK_DISABLED: 'true' }, `
      const otel = require('node:otel');
      otel.start();
      const span = otel.getTracer('t').startSpan('span');
      if (span.isRecording()) throw new Error('expected a non-recording span');
      span.end();
    `);
    assert.strictEqual(child.status, 0, child.stderr);
    assert.strictEqual(requests.length, 0);
  }

  collector.close();
}));

// Each case runs in a child process so that OTEL_* variables and the exit-time
// flush are exercised as an application would see them. Children are spawned
// asynchronously because the collector runs in this process.
function runChildAsync(port, env, script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--experimental-otel', '--no-warnings', '-e', script,
    ], {
      env: {
        ...process.env,
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => stdout += chunk);
    child.stderr.setEncoding('utf8').on('data', (chunk) => stderr += chunk);
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr, pid: child.pid }));
  });
}
