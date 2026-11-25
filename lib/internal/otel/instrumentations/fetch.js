'use strict';

const {
  NumberParseInt,
  ObjectKeys,
  SafeWeakMap,
  StringPrototypeSlice,
  StringPrototypeToLowerCase,
} = primordials;

const dc = require('diagnostics_channel');
const {
  active,
  isTracingSuppressed,
  setSpan,
} = require('internal/otel/context');
const {
  recordError,
  setMethodAttributes,
  setResponseStatus,
} = require('internal/otel/instrumentations/common');
const { inject } = require('internal/otel/propagation');
const { SpanKind } = require('internal/otel/span');
const { getTracer } = require('internal/otel/tracer');
const { URL } = require('internal/url');

let tracer;
const spans = new SafeWeakMap();

function hasHeader(headers, name) {
  for (let i = 0; i < headers.length; i += 2) {
    if (StringPrototypeToLowerCase(`${headers[i]}`) === name) return true;
  }
  return false;
}

function endSpan(request) {
  const span = spans.get(request);
  if (span === undefined) return;
  spans.delete(request);
  span.end();
}

function onRequestCreate({ request }) {
  const context = active();
  if (isTracingSuppressed(context)) return;

  let origin;
  try {
    origin = new URL(`${request.origin}`);
  } catch {
    return;
  }
  const attributes = {};
  const name = setMethodAttributes(attributes, request.method);
  attributes['server.address'] = origin.hostname[0] === '[' ?
    StringPrototypeSlice(origin.hostname, 1, -1) : origin.hostname;
  attributes['server.port'] = origin.port !== '' ?
    NumberParseInt(origin.port, 10) :
    (origin.protocol === 'https:' ? 443 : 80);
  attributes['url.full'] = `${origin.origin}${request.path}`;

  const span = tracer.startSpan(name, { kind: SpanKind.CLIENT, attributes }, context);
  spans.set(request, span);

  if (typeof request.addHeader !== 'function' ||
      (request.headers !== undefined && hasHeader(request.headers, 'traceparent'))) {
    return;
  }
  const carrier = {};
  inject(setSpan(context, span), carrier);
  const keys = ObjectKeys(carrier);
  for (let i = 0; i < keys.length; i++) {
    request.addHeader(keys[i], carrier[keys[i]]);
  }
}

function onRequestHeaders({ request, response }) {
  const span = spans.get(request);
  if (span === undefined) return;
  setResponseStatus(span, response.statusCode, 400);
}

function onRequestTrailers({ request }) {
  endSpan(request);
}

function onRequestError({ request, error }) {
  const span = spans.get(request);
  if (span === undefined) return;
  recordError(span, error);
  endSpan(request);
}

function enable() {
  tracer ??= getTracer('node:fetch', process.version);
  dc.subscribe('undici:request:create', onRequestCreate);
  dc.subscribe('undici:request:headers', onRequestHeaders);
  dc.subscribe('undici:request:trailers', onRequestTrailers);
  dc.subscribe('undici:request:error', onRequestError);
}

function disable() {
  dc.unsubscribe('undici:request:create', onRequestCreate);
  dc.unsubscribe('undici:request:headers', onRequestHeaders);
  dc.unsubscribe('undici:request:trailers', onRequestTrailers);
  dc.unsubscribe('undici:request:error', onRequestError);
}

module.exports = {
  disable,
  enable,
};
