'use strict';

const {
  ArrayPrototypePop,
  ObjectFreeze,
} = primordials;

const {
  codes: {
    ERR_INVALID_ARG_TYPE,
  },
} = require('internal/errors');
const {
  active,
  getSpan,
  isTracingSuppressed,
  setSpan,
  storage,
  validateContext,
} = require('internal/otel/context');
const { generateSpanId, generateTraceId } = require('internal/otel/ids');
const { kSampled } = require('internal/otel/sampler');
const {
  INVALID_SPAN_CONTEXT,
  NonRecordingSpan,
  Span,
  SpanKind,
  createSpanContext,
  isSpanContextValid,
} = require('internal/otel/span');
const { toTimestamp } = require('internal/otel/time');
const { kEmptyObject } = require('internal/util');
const {
  validateArray,
  validateFunction,
  validateObject,
  validateOneOf,
  validateString,
} = require('internal/validators');

const kSpanKinds = [
  SpanKind.INTERNAL,
  SpanKind.SERVER,
  SpanKind.CLIENT,
  SpanKind.PRODUCER,
  SpanKind.CONSUMER,
];

let activeProvider = null;

function getActiveProvider() {
  return activeProvider;
}

function setActiveProvider(provider) {
  activeProvider = provider;
}

function validateLinks(links) {
  if (links === undefined) return [];
  validateArray(links, 'options.links');
  for (let i = 0; i < links.length; i++) {
    validateObject(links[i], `options.links[${i}]`);
    if (!isSpanContextValid(links[i].context)) {
      throw new ERR_INVALID_ARG_TYPE(
        `options.links[${i}].context`, 'SpanContext', links[i].context);
    }
  }
  return links;
}

class TracerProvider {
  #resource;
  #sampler;
  #limits;
  #processor;

  constructor({ resource, sampler, limits, processor }) {
    this.#resource = resource;
    this.#sampler = sampler;
    this.#limits = limits;
    this.#processor = processor;
  }

  startSpan(instrumentationScope, name, options, parent, context) {
    const kind = options.kind ?? SpanKind.INTERNAL;
    validateOneOf(kind, 'options.kind', kSpanKinds);
    const links = validateLinks(options.links);
    const startTime = toTimestamp(options.startTime, 'options.startTime');

    const traceId = parent?.traceId ?? generateTraceId();
    const spanId = generateSpanId();
    const traceState = parent?.traceState;

    if (!this.#sampler.shouldSample(parent, traceId)) {
      return new NonRecordingSpan(
        createSpanContext(traceId, spanId, 0, traceState, false));
    }

    const span = new Span({
      name,
      kind,
      spanContext: createSpanContext(traceId, spanId, kSampled, traceState, false),
      parentSpanContext: parent,
      startTime,
      attributes: options.attributes,
      links,
      resource: this.#resource,
      instrumentationScope,
      limits: this.#limits,
      processor: this.#processor,
    });
    this.#processor.onStart(span, context);
    return span;
  }

  hasPendingSpans() {
    return this.#processor.hasPendingSpans();
  }

  forceFlush() {
    return this.#processor.forceFlush();
  }

  shutdown() {
    return this.#processor.shutdown();
  }
}

class Tracer {
  #instrumentationScope;

  constructor(instrumentationScope) {
    this.#instrumentationScope = instrumentationScope;
  }

  startSpan(name, options = kEmptyObject, context = active()) {
    validateString(name, 'name');
    validateObject(options, 'options');
    validateContext(context, 'context');

    const parentSpan = options.root === true ? undefined : getSpan(context);
    let parent = parentSpan?.spanContext();
    if (!isSpanContextValid(parent)) parent = undefined;

    const provider = activeProvider;
    if (provider === null || isTracingSuppressed(context)) {
      return new NonRecordingSpan(parent ?? INVALID_SPAN_CONTEXT);
    }
    return provider.startSpan(
      this.#instrumentationScope, name, options, parent, context);
  }

  // startActiveSpan(name[, options[, context]], fn)
  startActiveSpan(name, ...args) {
    const fn = ArrayPrototypePop(args);
    validateFunction(fn, 'fn');
    const options = args[0] ?? kEmptyObject;
    const context = args[1] ?? active();
    const span = this.startSpan(name, options, context);
    return storage.run(setSpan(context, span), fn, span);
  }
}

function getTracer(name, version, options = kEmptyObject) {
  validateString(name, 'name');
  if (version !== undefined) validateString(version, 'version');
  validateObject(options, 'options');
  const { schemaUrl } = options;
  if (schemaUrl !== undefined) validateString(schemaUrl, 'options.schemaUrl');
  return new Tracer(ObjectFreeze({
    __proto__: null,
    name,
    version,
    schemaUrl,
  }));
}

module.exports = {
  Tracer,
  TracerProvider,
  getActiveProvider,
  getTracer,
  setActiveProvider,
};
