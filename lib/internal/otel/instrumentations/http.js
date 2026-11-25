'use strict';

const {
  ObjectKeys,
  RegExpPrototypeExec,
  SafeWeakMap,
  StringPrototypeIndexOf,
  StringPrototypeSlice,
} = primordials;

const dc = require('diagnostics_channel');
const {
  ROOT_CONTEXT,
  active,
  isTracingSuppressed,
  setSpan,
  storage,
} = require('internal/otel/context');
const {
  recordError,
  setMethodAttributes,
  setResponseStatus,
  splitHostPort,
} = require('internal/otel/instrumentations/common');
const { extract, inject } = require('internal/otel/propagation');
const { SpanKind } = require('internal/otel/span');
const { getTracer } = require('internal/otel/tracer');

const kAbsoluteUrlRegExp = /^https?:\/\//i;

const serverRequestStart = dc.channel('http.server.request.start');

let tracer;
const clientSpans = new SafeWeakMap();
const serverSpans = new SafeWeakMap();

function endClientSpan(request) {
  const span = clientSpans.get(request);
  if (span === undefined) return;
  clientSpans.delete(request);
  span.end();
}

function onClientRequestClose() {
  endClientSpan(this);
}

function onClientRequestCreated({ request }) {
  const context = active();
  if (isTracingSuppressed(context)) return;

  const attributes = {};
  const name = setMethodAttributes(attributes, request.method);
  const protocol = request.protocol ?? 'http:';
  const authority = request.getHeader('host') ?? request.host;
  const { address, port } = splitHostPort(`${authority}`);
  attributes['server.address'] = address ?? request.host;
  attributes['server.port'] = port ?? (protocol === 'https:' ? 443 : 80);
  attributes['url.full'] = RegExpPrototypeExec(kAbsoluteUrlRegExp, request.path) !== null ?
    request.path : `${protocol}//${authority}${request.path}`;

  const span = tracer.startSpan(name, { kind: SpanKind.CLIENT, attributes }, context);
  clientSpans.set(request, span);
  request.once('close', onClientRequestClose);

  if (!request.headersSent) {
    const carrier = {};
    inject(setSpan(context, span), carrier);
    const keys = ObjectKeys(carrier);
    for (let i = 0; i < keys.length; i++) {
      request.setHeader(keys[i], carrier[keys[i]]);
    }
  }
}

function onClientResponseFinish({ request, response }) {
  const span = clientSpans.get(request);
  if (span === undefined) return;
  span.setAttribute('network.protocol.version', response.httpVersion);
  setResponseStatus(span, response.statusCode, 400);
}

function onClientRequestError({ request, error }) {
  const span = clientSpans.get(request);
  if (span === undefined) return;
  recordError(span, error);
  endClientSpan(request);
}

function endServerSpan(response) {
  const span = serverSpans.get(response);
  if (span === undefined) return;
  serverSpans.delete(response);
  span.end();
}

function onServerResponseClose() {
  endServerSpan(this);
}

// Runs as the bindStore() transform of http.server.request.start, so the
// returned context is active while the request is dispatched.
function startServerSpan({ request, response, socket }) {
  const parentContext = extract(ROOT_CONTEXT, request.headers);
  const scheme = socket?.encrypted ? 'https' : 'http';

  const attributes = {};
  const name = setMethodAttributes(attributes, request.method);
  const url = request.url ?? '';
  const queryIndex = StringPrototypeIndexOf(url, '?');
  if (queryIndex === -1) {
    attributes['url.path'] = url;
  } else {
    attributes['url.path'] = StringPrototypeSlice(url, 0, queryIndex);
    attributes['url.query'] = StringPrototypeSlice(url, queryIndex + 1);
  }
  attributes['url.scheme'] = scheme;
  const { address, port } = splitHostPort(request.headers.host);
  if (address !== undefined) {
    attributes['server.address'] = address;
    attributes['server.port'] = port ?? (scheme === 'https' ? 443 : 80);
  }
  if (socket?.remoteAddress !== undefined) {
    attributes['client.address'] = socket.remoteAddress;
    attributes['network.peer.address'] = socket.remoteAddress;
    attributes['network.peer.port'] = socket.remotePort;
  }
  const userAgent = request.headers['user-agent'];
  if (userAgent !== undefined) attributes['user_agent.original'] = userAgent;
  attributes['network.protocol.version'] = request.httpVersion;

  const span = tracer.startSpan(
    name, { kind: SpanKind.SERVER, attributes }, parentContext);
  serverSpans.set(response, span);
  response.once('close', onServerResponseClose);
  return setSpan(parentContext, span);
}

function onServerResponseFinish({ response }) {
  const span = serverSpans.get(response);
  if (span === undefined) return;
  setResponseStatus(span, response.statusCode, 500);
  endServerSpan(response);
}

function enable() {
  tracer ??= getTracer('node:http', process.version);
  dc.subscribe('http.client.request.created', onClientRequestCreated);
  dc.subscribe('http.client.response.finish', onClientResponseFinish);
  dc.subscribe('http.client.request.error', onClientRequestError);
  serverRequestStart.bindStore(storage, startServerSpan);
  dc.subscribe('http.server.response.finish', onServerResponseFinish);
}

function disable() {
  dc.unsubscribe('http.client.request.created', onClientRequestCreated);
  dc.unsubscribe('http.client.response.finish', onClientResponseFinish);
  dc.unsubscribe('http.client.request.error', onClientRequestError);
  serverRequestStart.unbindStore(storage);
  dc.unsubscribe('http.server.response.finish', onServerResponseFinish);
}

module.exports = {
  disable,
  enable,
};
