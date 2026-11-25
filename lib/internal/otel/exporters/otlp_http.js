'use strict';

const {
  ArrayFrom,
  ArrayIsArray,
  ArrayPrototypeMap,
  ArrayPrototypePush,
  JSONStringify,
  NumberIsFinite,
  NumberIsSafeInteger,
  ObjectKeys,
  Promise,
  SafeMap,
  StringPrototypeEndsWith,
} = primordials;

const { AbortSignal } = require('internal/abort_controller');
const { Buffer } = require('buffer');
const {
  codes: {
    ERR_INVALID_ARG_VALUE,
  },
  genericNodeError,
} = require('internal/errors');
const {
  active,
  suppressTracing,
  withContext,
} = require('internal/otel/context');
const {
  getEnv,
  getEnvInteger,
  getEnvKeyValueList,
} = require('internal/otel/config');
const { emitWarning } = require('internal/process/warning');
const { URL } = require('internal/url');
const { validateObject, validateString } = require('internal/validators');

const kDefaultEndpoint = 'http://localhost:4318/v1/traces';
const kHasIsRemote = 0x100;
const kIsRemote = 0x200;

function encodeValue(value) {
  switch (typeof value) {
    case 'string':
      return { stringValue: value };
    case 'boolean':
      return { boolValue: value };
    case 'number':
      if (NumberIsSafeInteger(value)) return { intValue: `${value}` };
      return { doubleValue: NumberIsFinite(value) ? value : `${value}` };
    default:
      if (ArrayIsArray(value)) {
        return { arrayValue: { values: ArrayPrototypeMap(value, encodeValue) } };
      }
      return {};
  }
}

function encodeAttributes(attributes) {
  return ArrayPrototypeMap(ObjectKeys(attributes), (key) => ({
    key,
    value: encodeValue(attributes[key]),
  }));
}

function encodeEvent(event) {
  return {
    timeUnixNano: `${event.time}`,
    name: event.name,
    attributes: encodeAttributes(event.attributes),
    droppedAttributesCount: event.droppedAttributesCount,
  };
}

function encodeLink(link) {
  const encoded = {
    traceId: link.context.traceId,
    spanId: link.context.spanId,
    attributes: encodeAttributes(link.attributes),
    droppedAttributesCount: link.droppedAttributesCount,
    flags: (link.context.traceFlags & 0xff) | kHasIsRemote |
      (link.context.isRemote ? kIsRemote : 0),
  };
  if (link.context.traceState !== undefined) {
    encoded.traceState = link.context.traceState;
  }
  return encoded;
}

function encodeSpan(span) {
  const spanContext = span.spanContext();
  const parent = span.parentSpanContext;
  const encoded = {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    name: span.name,
    // OTLP reserves 0 for SPAN_KIND_UNSPECIFIED.
    kind: span.kind + 1,
    startTimeUnixNano: `${span.startTime}`,
    endTimeUnixNano: `${span.endTime}`,
    attributes: encodeAttributes(span.attributes),
    droppedAttributesCount: span.droppedAttributesCount,
    events: ArrayPrototypeMap(span.events, encodeEvent),
    droppedEventsCount: span.droppedEventsCount,
    links: ArrayPrototypeMap(span.links, encodeLink),
    droppedLinksCount: span.droppedLinksCount,
    status: { code: span.status.code },
    flags: (spanContext.traceFlags & 0xff) | kHasIsRemote |
      (parent?.isRemote ? kIsRemote : 0),
  };
  if (spanContext.traceState !== undefined) {
    encoded.traceState = spanContext.traceState;
  }
  if (parent !== undefined) encoded.parentSpanId = parent.spanId;
  if (span.status.message !== undefined) {
    encoded.status.message = span.status.message;
  }
  return encoded;
}

// Builds an ExportTraceServiceRequest in the OTLP/JSON encoding, grouping spans
// by resource and instrumentation scope.
function encodeTraces(spans) {
  const resources = new SafeMap();
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    let scopes = resources.get(span.resource);
    if (scopes === undefined) {
      scopes = new SafeMap();
      resources.set(span.resource, scopes);
    }
    const scope = span.instrumentationScope;
    const scopeKey = `${scope.name}\0${scope.version}\0${scope.schemaUrl}`;
    let scopeSpans = scopes.get(scopeKey);
    if (scopeSpans === undefined) {
      const encodedScope = { name: scope.name };
      if (scope.version !== undefined) encodedScope.version = scope.version;
      scopeSpans = { scope: encodedScope, spans: [] };
      if (scope.schemaUrl !== undefined) scopeSpans.schemaUrl = scope.schemaUrl;
      scopes.set(scopeKey, scopeSpans);
    }
    ArrayPrototypePush(scopeSpans.spans, encodeSpan(span));
  }

  const resourceSpans = [];
  for (const { 0: resource, 1: scopes } of resources) {
    ArrayPrototypePush(resourceSpans, {
      resource: {
        attributes: encodeAttributes(resource.attributes),
        droppedAttributesCount: resource.droppedAttributesCount,
      },
      scopeSpans: ArrayFrom(scopes.values()),
    });
  }
  return { resourceSpans };
}

function resolveEndpoint(endpoint) {
  if (endpoint === undefined) {
    endpoint = getEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT');
  }
  if (endpoint === undefined) {
    const base = getEnv('OTEL_EXPORTER_OTLP_ENDPOINT');
    if (base === undefined) return new URL(kDefaultEndpoint);
    endpoint = StringPrototypeEndsWith(base, '/') ?
      `${base}v1/traces` : `${base}/v1/traces`;
  }
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ERR_INVALID_ARG_VALUE('options.endpoint', endpoint, 'must be a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ERR_INVALID_ARG_VALUE('options.endpoint', endpoint, 'must be an http: or https: URL');
  }
  return url;
}

function resolveHeaders(headers) {
  const resolved = {
    __proto__: null,
    ...getEnvKeyValueList('OTEL_EXPORTER_OTLP_HEADERS'),
    ...getEnvKeyValueList('OTEL_EXPORTER_OTLP_TRACES_HEADERS'),
  };
  if (headers !== undefined) {
    validateObject(headers, 'options.headers');
    const keys = ObjectKeys(headers);
    for (let i = 0; i < keys.length; i++) {
      validateString(headers[keys[i]], `options.headers.${keys[i]}`);
      resolved[keys[i]] = headers[keys[i]];
    }
  }
  return resolved;
}

let warnedProtocol = false;

class OTLPHttpJsonExporter {
  #url;
  #headers;
  #timeout;
  #agent;

  constructor(options) {
    this.#url = resolveEndpoint(options.endpoint);
    this.#headers = resolveHeaders(options.headers);
    this.#timeout = getEnvInteger(
      'OTEL_EXPORTER_OTLP_TRACES_TIMEOUT',
      getEnvInteger('OTEL_EXPORTER_OTLP_TIMEOUT', 10000));

    const protocol = getEnv('OTEL_EXPORTER_OTLP_TRACES_PROTOCOL') ??
      getEnv('OTEL_EXPORTER_OTLP_PROTOCOL');
    if (protocol !== undefined && protocol !== 'http/json' && !warnedProtocol) {
      warnedProtocol = true;
      emitWarning(`OTLP protocol ${protocol} is not supported; using http/json`,
                  'OpenTelemetryWarning');
    }
  }

  export(spans, { signal }) {
    const body = JSONStringify(encodeTraces(spans));
    const http = this.#url.protocol === 'https:' ? require('https') : require('http');
    this.#agent ??= new http.Agent({ keepAlive: true });
    const options = {
      method: 'POST',
      agent: this.#agent,
      headers: {
        ...this.#headers,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.#timeout)]),
    };

    return new Promise((resolve, reject) => {
      // The exporter's own requests must not produce spans.
      withContext(suppressTracing(active()), () => {
        const req = http.request(this.#url, options, (res) => {
          res.resume();
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve();
            } else {
              reject(genericNodeError(
                `OTLP endpoint responded with status ${res.statusCode}`,
                { statusCode: res.statusCode }));
            }
          });
          res.on('error', reject);
        });
        req.on('error', reject);
        req.end(body);
      });
    });
  }

  shutdown() {
    this.#agent?.destroy();
  }
}

module.exports = {
  OTLPHttpJsonExporter,
  encodeTraces,
};
