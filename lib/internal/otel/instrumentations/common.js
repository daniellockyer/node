'use strict';

const {
  NumberParseInt,
  SafeSet,
  StringPrototypeIncludes,
  StringPrototypeIndexOf,
  StringPrototypeLastIndexOf,
  StringPrototypeSlice,
  StringPrototypeToUpperCase,
} = primordials;

const { SpanStatusCode } = require('internal/otel/span');

const kKnownMethods = new SafeSet([
  'CONNECT', 'DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT',
  'QUERY', 'TRACE',
]);

// Sets http.request.method as the HTTP semantic conventions require and
// returns the span name.
function setMethodAttributes(attributes, method) {
  const upper = typeof method === 'string' ? StringPrototypeToUpperCase(method) : '';
  if (kKnownMethods.has(upper)) {
    attributes['http.request.method'] = upper;
    return upper;
  }
  attributes['http.request.method'] = '_OTHER';
  if (typeof method === 'string') {
    attributes['http.request.method_original'] = method;
  }
  return 'HTTP';
}

// Splits a Host header or authority into its address and port. IPv6 addresses
// are returned without brackets.
function splitHostPort(value) {
  if (typeof value !== 'string' || value === '') return {};
  if (value[0] === '[') {
    const end = StringPrototypeIndexOf(value, ']');
    if (end === -1) return { address: value };
    const address = StringPrototypeSlice(value, 1, end);
    if (value[end + 1] !== ':') return { address };
    return { address, port: parsePort(StringPrototypeSlice(value, end + 2)) };
  }
  const index = StringPrototypeLastIndexOf(value, ':');
  if (index === -1 || StringPrototypeIncludes(StringPrototypeSlice(value, 0, index), ':')) {
    return { address: value };
  }
  return {
    address: StringPrototypeSlice(value, 0, index),
    port: parsePort(StringPrototypeSlice(value, index + 1)),
  };
}

function parsePort(value) {
  const port = NumberParseInt(value, 10);
  return port >= 0 && port <= 65535 ? port : undefined;
}

function setResponseStatus(span, statusCode, errorThreshold) {
  span.setAttribute('http.response.status_code', statusCode);
  if (statusCode >= errorThreshold) {
    span.setAttribute('error.type', `${statusCode}`);
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
}

function recordError(span, error) {
  span.recordException(error);
  span.setAttribute('error.type', `${error?.code ?? error?.name ?? '_OTHER'}`);
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: typeof error?.message === 'string' ? error.message : undefined,
  });
}

module.exports = {
  recordError,
  setMethodAttributes,
  setResponseStatus,
  splitHostPort,
};
