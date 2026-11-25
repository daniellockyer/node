# OpenTelemetry

<!--introduced_in=REPLACEME-->

<!-- YAML
added: REPLACEME
-->

> Stability: 1.0 - Early development. Enable this API with the
> [`--experimental-otel`][] CLI flag.

<!-- source_link=lib/otel.js -->

The `node:otel` module provides a built-in [OpenTelemetry][] tracing SDK. It
records spans for HTTP and `fetch()` traffic automatically, lets applications
create their own spans, propagates [W3C Trace Context][] between services, and
exports spans to any collector that accepts [OTLP][] over HTTP.

To access it:

```mjs
import otel from 'node:otel';
```

```cjs
const otel = require('node:otel');
```

This module is only available under the `node:` scheme.

## Getting started

Tracing starts when [`otel.start()`][] is called. Instrumentation applies to
requests made after that point, so call it before the application creates
servers or makes requests. The simplest way to do that without changing the
application is a preloaded module:

```mjs
// otel-setup.mjs
import otel from 'node:otel';

otel.start({ serviceName: 'checkout' });
```

```bash
node --experimental-otel --import ./otel-setup.mjs app.js
```

Spans are exported in batches to `http://localhost:4318/v1/traces` unless an
endpoint is configured through options or [environment variables][]. Pending
spans are flushed when the event loop empties. Spans that are still buffered
when the process ends through `process.exit()`, a signal, or an uncaught
exception are lost; call [`otel.flush()`][] or [`otel.stop()`][] first where
that matters.

Applications can add their own spans with a [`Tracer`][]:

```mjs
import otel from 'node:otel';

const tracer = otel.getTracer('checkout', '1.0.0');

export async function placeOrder(order) {
  return tracer.startActiveSpan('placeOrder', async (span) => {
    try {
      span.setAttribute('order.items', order.items.length);
      return await saveOrder(order);
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: otel.SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
```

```cjs
const otel = require('node:otel');

const tracer = otel.getTracer('checkout', '1.0.0');

async function placeOrder(order) {
  return tracer.startActiveSpan('placeOrder', async (span) => {
    try {
      span.setAttribute('order.items', order.items.length);
      return await saveOrder(order);
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: otel.SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
```

Spans started while another span is active become its children, including
across `await`, timers, and other asynchronous operations. The active context
is tracked with an [`AsyncLocalStorage`][].

Tracers can be obtained before `otel.start()` is called. Until tracing starts,
and after it stops, they return spans that record nothing.

The API mirrors the shape of the [OpenTelemetry JavaScript API][], but
`node:otel` is self-contained: it does not interact with the
`@opentelemetry/api` package or with SDKs installed from npm.

## Automatic instrumentation

While tracing is started, the following are instrumented through
[diagnostics channels][]:

* `http` and `https` servers: a `SERVER` span for each request. The request
  listener runs with that span active, so spans created while handling the
  request become its children. An incoming `traceparent` header makes the span
  a child of the remote caller.
* `http.request()` and `https.request()`: a `CLIENT` span for each request,
  with a `traceparent` header added before the headers are sent.
* `fetch()`: a `CLIENT` span for each request, with a `traceparent` header
  added unless the caller already set one.

Span names and attributes follow the stable OpenTelemetry
[HTTP semantic conventions][]. Server spans are named after the request method
only, because routes are not known to Node.js. Server spans are marked as
errors for `5xx` responses, and client spans for `4xx` and `5xx` responses and
for request errors.

Requests made by the exporter itself are never traced.

## Environment variables

Options passed to [`otel.start()`][] take precedence over these variables.

* `OTEL_SDK_DISABLED`: when `true`, `otel.start()` does nothing.
* `OTEL_SERVICE_NAME`: the `service.name` resource attribute.
* `OTEL_RESOURCE_ATTRIBUTES`: additional resource attributes, as
  comma-separated `key=value` pairs. Keys and values are percent-decoded.
* `OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG`: the sampler and its
  ratio. See the `sampler` option of [`otel.start()`][].
* `OTEL_EXPORTER_OTLP_ENDPOINT`: the base URL of the collector. `/v1/traces` is
  appended to it.
* `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`: the full URL to send spans to.
* `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_TRACES_HEADERS`: headers
  to send with each export, as comma-separated `key=value` pairs.
* `OTEL_EXPORTER_OTLP_TIMEOUT` and `OTEL_EXPORTER_OTLP_TRACES_TIMEOUT`: the
  timeout for each export request, in milliseconds. **Default:** `10000`.
* `OTEL_EXPORTER_OTLP_PROTOCOL` and `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL`: only
  `http/json` is supported. Other values produce a warning.
* `OTEL_BSP_SCHEDULE_DELAY`: the delay between exports, in milliseconds.
  **Default:** `5000`.
* `OTEL_BSP_EXPORT_TIMEOUT`: the time an export may take before it is aborted,
  in milliseconds. **Default:** `30000`.
* `OTEL_BSP_MAX_QUEUE_SIZE`: the maximum number of ended spans waiting to be
  exported. Further spans are dropped. **Default:** `2048`.
* `OTEL_BSP_MAX_EXPORT_BATCH_SIZE`: the maximum number of spans per export.
  **Default:** `512`.
* `OTEL_ATTRIBUTE_COUNT_LIMIT`, `OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT`,
  `OTEL_EVENT_ATTRIBUTE_COUNT_LIMIT`, and `OTEL_LINK_ATTRIBUTE_COUNT_LIMIT`:
  the maximum number of attributes. **Default:** `128`.
* `OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT` and
  `OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT`: the maximum length of string
  attribute values. **Default:** unlimited.
* `OTEL_SPAN_EVENT_COUNT_LIMIT` and `OTEL_SPAN_LINK_COUNT_LIMIT`: the maximum
  number of events and links per span. **Default:** `128`.

Invalid values produce an `OpenTelemetryWarning` and are ignored.

## `otel.start([options])`

<!-- YAML
added: REPLACEME
-->

* `options` {Object}
  * `serviceName` {string} The `service.name` resource attribute.
    **Default:** `OTEL_SERVICE_NAME`, or `unknown_service:node`.
  * `resource` {Object} Additional resource attributes.
  * `sampler` {string} One of `'always_on'`, `'always_off'`, `'traceidratio'`,
    `'parentbased_always_on'`, `'parentbased_always_off'`, or
    `'parentbased_traceidratio'`. The parent-based samplers follow the sampling
    decision of the parent span when there is one. **Default:**
    `'parentbased_always_on'`.
  * `samplerArg` {number} The fraction of traces to sample, between `0` and `1`,
    for the ratio samplers. **Default:** `1`.
  * `endpoint` {string} The `http:` or `https:` URL to send spans to.
    **Default:** `'http://localhost:4318/v1/traces'`.
  * `headers` {Object} Headers to send with each export.
  * `exporter` {Object} An exporter to use instead of OTLP. See
    [Custom exporters][].
  * `instrumentations` {Object}
    * `http` {boolean} Instrument `http` and `https`. **Default:** `true`.
    * `fetch` {boolean} Instrument `fetch()`. **Default:** `true`.

Starts recording and exporting spans, and enables automatic instrumentation.
Throws `ERR_INVALID_STATE` if tracing has already been started.

## `otel.stop()`

<!-- YAML
added: REPLACEME
-->

* Returns: {Promise} Fulfilled once pending spans have been exported.

Disables instrumentation, stops recording spans, exports the spans that have
ended, and shuts the exporter down. Spans that have not ended are discarded.
Tracing can be started again afterwards.

## `otel.flush()`

<!-- YAML
added: REPLACEME
-->

* Returns: {Promise} Fulfilled once pending spans have been exported.

Exports every span that has ended without waiting for the next scheduled
export.

## `otel.getTracer(name[, version][, options])`

<!-- YAML
added: REPLACEME
-->

* `name` {string} The name of the instrumentation scope, usually the name of
  the library or application component creating spans.
* `version` {string} The version of the instrumentation scope.
* `options` {Object}
  * `schemaUrl` {string} The schema URL of the attributes used by the scope.
* Returns: {Tracer}

## `otel.context`

<!-- YAML
added: REPLACEME
-->

### `otel.context.active()`

* Returns: {Context} The active context, or [`otel.ROOT_CONTEXT`][] if none is
  active.

### `otel.context.with(context, fn[, thisArg[, ...args]])`

* `context` {Context}
* `fn` {Function}
* `thisArg` {any}
* `...args` {any}
* Returns: {any} The return value of `fn`.

Calls `fn` with `context` as the active context.

### `otel.context.bind(context, fn)`

* `context` {Context}
* `fn` {Function}
* Returns: {Function} A function that calls `fn` with `context` active.

## `otel.trace`

<!-- YAML
added: REPLACEME
-->

### `otel.trace.getActiveSpan()`

* Returns: {Span|undefined} The span of the active context.

### `otel.trace.getSpan(context)`

* `context` {Context}
* Returns: {Span|undefined}

### `otel.trace.setSpan(context, span)`

* `context` {Context}
* `span` {Span}
* Returns: {Context} A copy of `context` with `span` as its span.

### `otel.trace.isSpanContextValid(spanContext)`

* `spanContext` {Object}
* Returns: {boolean} Whether `spanContext` has a valid trace ID and span ID.

## `otel.propagation`

<!-- YAML
added: REPLACEME
-->

Reads and writes [W3C Trace Context][] headers, for protocols that are not
instrumented automatically.

A carrier is a {Headers} object or any object with set() and get() methods,
or a plain object whose keys are lowercase header names, such as
[`message.headers`][].

### `otel.propagation.inject(context, carrier)`

* `context` {Context}
* `carrier` {Object}

Writes the `traceparent` and `tracestate` headers for the span of `context`
into `carrier`. Nothing is written if `context` has no valid span.

### `otel.propagation.extract(context, carrier)`

* `context` {Context}
* `carrier` {Object}
* Returns: {Context}

Returns a copy of `context` whose span is the remote parent described by the
`traceparent` and `tracestate` headers of `carrier`, or `context` itself if
those headers are missing or invalid.

```mjs
import otel from 'node:otel';

const tracer = otel.getTracer('worker');

function onMessage(message) {
  const parent = otel.propagation.extract(otel.ROOT_CONTEXT, message.headers);
  const span = tracer.startSpan('process message', {
    kind: otel.SpanKind.CONSUMER,
  }, parent);
  // ...
  span.end();
}
```

## `otel.createContextKey(description)`

<!-- YAML
added: REPLACEME
-->

* `description` {string}
* Returns: {symbol} A key for [`context.setValue()`][].

## `otel.ROOT_CONTEXT`

<!-- YAML
added: REPLACEME
-->

* Type: {Context}

An empty context.

## `otel.SpanKind`

<!-- YAML
added: REPLACEME
-->

* Type: {Object}

The role of a span: `INTERNAL` (`0`), `SERVER` (`1`), `CLIENT` (`2`), `PRODUCER`
(`3`), or `CONSUMER` (`4`).

## `otel.SpanStatusCode`

<!-- YAML
added: REPLACEME
-->

* Type: {Object}

The status of a span: `UNSET` (`0`), `OK` (`1`), or `ERROR` (`2`).

## Class: `Context`

<!-- YAML
added: REPLACEME
-->

An immutable set of values, including the active span, that is propagated
through asynchronous operations.

### `context.getValue(key)`

* `key` {symbol}
* Returns: {any}

### `context.setValue(key, value)`

* `key` {symbol}
* `value` {any}
* Returns: {Context} A copy of the context with `key` set to `value`.

### `context.deleteValue(key)`

* `key` {symbol}
* Returns: {Context} A copy of the context without `key`.

## Class: `Tracer`

<!-- YAML
added: REPLACEME
-->

Created with [`otel.getTracer()`][].

### `tracer.startSpan(name[, options[, context]])`

* `name` {string}
* `options` {Object}
  * `kind` {number} A [`otel.SpanKind`][] value. **Default:**
    `otel.SpanKind.INTERNAL`.
  * `attributes` {Object} The initial attributes of the span.
  * `links` {Object\[]} Links to other spans. Each link is an object with a
    `context` property, set to the other span's [`span.spanContext()`][], and
    an optional `attributes` property.
  * `startTime` {number|Date} The start time, in milliseconds since the epoch.
    **Default:** now.
  * `root` {boolean} Start a new trace instead of using the span of `context`
    as the parent. **Default:** `false`.
* `context` {Context} The context whose span is the parent. **Default:**
  [`otel.context.active()`][].
* Returns: {Span}

Starts a span without making it active. The span must be ended with
[`span.end()`][].

### `tracer.startActiveSpan(name[, options[, context]], fn)`

* `name` {string}
* `options` {Object} See [`tracer.startSpan()`][].
* `context` {Context} See [`tracer.startSpan()`][].
* `fn` {Function} Called with the new span as its only argument.
* Returns: {any} The return value of `fn`.

Starts a span and calls `fn` with the span active. The span is not ended
automatically when `fn` returns.

## Class: `Span`

<!-- YAML
added: REPLACEME
-->

A timed operation within a trace. Spans are created with a [`Tracer`][].

The methods that modify a span return the span, and have no effect after it
has ended. Attribute values must be strings, numbers, booleans, or arrays of
one of those types; other values are silently ignored, so that instrumentation
never throws because of the data it records.

Spans that are not recording, because tracing is not started or the span was
not sampled, implement only the methods.

### `span.spanContext()`

* Returns: {Object}
  * `traceId` {string} 32 lowercase hexadecimal characters.
  * `spanId` {string} 16 lowercase hexadecimal characters.
  * `traceFlags` {number} `1` if the span is sampled, otherwise `0`.
  * `traceState` {string|undefined} The W3C `tracestate` value.
  * `isRemote` {boolean} Whether the span context was extracted from another
    process.

### `span.setAttribute(key, value)`

* `key` {string}
* `value` {string|number|boolean|Array}
* Returns: {Span}

### `span.setAttributes(attributes)`

* `attributes` {Object}
* Returns: {Span}

### `span.addEvent(name[, attributes][, time])`

* `name` {string}
* `attributes` {Object}
* `time` {number|Date} In milliseconds since the epoch. **Default:** now.
* Returns: {Span}

### `span.recordException(exception[, time])`

* `exception` {Error|string}
* `time` {number|Date} In milliseconds since the epoch. **Default:** now.
* Returns: {Span}

Adds an `exception` event describing `exception`. The span's status is not
changed.

### `span.setStatus(status)`

* `status` {Object}
  * `code` {number} A [`otel.SpanStatusCode`][] value.
  * `message` {string} A description, kept only for `ERROR`.
* Returns: {Span}

Once set to `OK`, the status can no longer change. Setting `UNSET` has no
effect.

### `span.updateName(name)`

* `name` {string}
* Returns: {Span}

### `span.end([endTime])`

* `endTime` {number|Date} In milliseconds since the epoch. **Default:** now.

Ends the span and queues it for export. Further calls have no effect.

### `span.isRecording()`

* Returns: {boolean} `true` until the span has ended, and always `false` for
  spans that are not recorded.

### Exported span properties

The spans passed to exporters, and returned by
[`inMemorySpanExporter.getFinishedSpans()`][], also have these read-only
properties:

* `name` {string}
* `kind` {number}
* `parentSpanContext` {Object|undefined}
* `startTime` {bigint} Nanoseconds since the epoch.
* `endTime` {bigint} Nanoseconds since the epoch.
* `ended` {boolean}
* `attributes` {Object}
* `droppedAttributesCount` {number}
* `events` {Object\[]} Each event has `name`, `time`, `attributes` and
  `droppedAttributesCount` properties.
* `droppedEventsCount` {number}
* `links` {Object\[]} Each link has `context`, `attributes` and
  `droppedAttributesCount` properties.
* `droppedLinksCount` {number}
* `status` {Object} With `code` and `message` properties.
* `resource` {Object} With `attributes` and `droppedAttributesCount`
  properties.
* `instrumentationScope` {Object} With `name`, `version` and `schemaUrl`
  properties.

## Class: `InMemorySpanExporter`

<!-- YAML
added: REPLACEME
-->

An exporter that keeps spans in memory, for tests.

```mjs
import otel from 'node:otel';

const exporter = new otel.InMemorySpanExporter();
otel.start({ exporter });
otel.getTracer('test').startSpan('work').end();
await otel.flush();
console.log(exporter.getFinishedSpans()[0].name); // 'work'
```

### `inMemorySpanExporter.getFinishedSpans()`

* Returns: {Span\[]} The spans exported so far.

### `inMemorySpanExporter.reset()`

Discards the spans exported so far.

## Custom exporters

The `exporter` option of [`otel.start()`][] accepts any object with the
following methods:

* `export(spans, options)`: called with an array of ended spans and an options
  object whose `signal` property is an {AbortSignal} that is aborted after
  `OTEL_BSP_EXPORT_TIMEOUT`. Must return a {Promise}. A rejected promise is
  reported once as an `OpenTelemetryWarning`; the spans are not retried.
* `shutdown()`: optional. Called by [`otel.stop()`][] after the final export.

[Custom exporters]: #custom-exporters
[HTTP semantic conventions]: https://opentelemetry.io/docs/specs/semconv/http/http-spans/
[OTLP]: https://opentelemetry.io/docs/specs/otlp/
[OpenTelemetry]: https://opentelemetry.io/
[OpenTelemetry JavaScript API]: https://github.com/open-telemetry/opentelemetry-js/tree/main/api
[W3C Trace Context]: https://www.w3.org/TR/trace-context/
[`--experimental-otel`]: cli.md#--experimental-otel
[`AsyncLocalStorage`]: async_context.md#class-asynclocalstorage
[`Tracer`]: #class-tracer
[`context.setValue()`]: #contextsetvaluekey-value
[`inMemorySpanExporter.getFinishedSpans()`]: #inmemoryspanexportergetfinishedspans
[`message.headers`]: http.md#messageheaders
[`otel.ROOT_CONTEXT`]: #otelroot_context
[`otel.SpanKind`]: #otelspankind
[`otel.SpanStatusCode`]: #otelspanstatuscode
[`otel.context.active()`]: #otelcontextactive
[`otel.flush()`]: #otelflush
[`otel.getTracer()`]: #otelgettracername-version-options
[`otel.start()`]: #otelstartoptions
[`otel.stop()`]: #otelstop
[`span.end()`]: #spanendendtime
[`span.spanContext()`]: #spanspancontext
[`tracer.startSpan()`]: #tracerstartspanname-options-context
[diagnostics channels]: diagnostics_channel.md
[environment variables]: #environment-variables
