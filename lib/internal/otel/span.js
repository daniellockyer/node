'use strict';

const {
  ArrayPrototypePush,
  ArrayPrototypeSlice,
  ObjectFreeze,
} = primordials;

const { Attributes } = require('internal/otel/attributes');
const {
  kInvalidSpanId,
  kInvalidTraceId,
  isValidSpanId,
  isValidTraceId,
} = require('internal/otel/ids');
const { toTimestamp } = require('internal/otel/time');
const { isDate, isNativeError } = require('internal/util/types');
const {
  validateObject,
  validateOneOf,
  validateString,
} = require('internal/validators');

const SpanKind = ObjectFreeze({
  __proto__: null,
  INTERNAL: 0,
  SERVER: 1,
  CLIENT: 2,
  PRODUCER: 3,
  CONSUMER: 4,
});

const SpanStatusCode = ObjectFreeze({
  __proto__: null,
  UNSET: 0,
  OK: 1,
  ERROR: 2,
});

const kUnsetStatus = ObjectFreeze({ code: SpanStatusCode.UNSET, message: undefined });

function createSpanContext(traceId, spanId, traceFlags, traceState, isRemote) {
  return ObjectFreeze({
    traceId,
    spanId,
    traceFlags,
    traceState,
    isRemote,
  });
}

const INVALID_SPAN_CONTEXT =
  createSpanContext(kInvalidTraceId, kInvalidSpanId, 0, undefined, false);

function isSpanContextValid(spanContext) {
  return spanContext !== null && typeof spanContext === 'object' &&
    isValidTraceId(spanContext.traceId) && isValidSpanId(spanContext.spanId);
}

// Carries a span context without recording anything. Used when tracing is not
// started, is suppressed, or the span was not sampled, and for remote parents.
class NonRecordingSpan {
  #spanContext;

  constructor(spanContext) {
    this.#spanContext = spanContext;
  }

  spanContext() {
    return this.#spanContext;
  }

  setAttribute() {
    return this;
  }

  setAttributes() {
    return this;
  }

  addEvent() {
    return this;
  }

  setStatus() {
    return this;
  }

  updateName() {
    return this;
  }

  recordException() {
    return this;
  }

  end() {}

  isRecording() {
    return false;
  }
}

function exceptionAttributes(exception) {
  if (typeof exception === 'string') {
    return { '__proto__': null, 'exception.message': exception };
  }
  const attributes = { __proto__: null };
  if (exception === null || typeof exception !== 'object') return attributes;
  const type = exception.code ?? exception.name;
  if (type !== undefined) attributes['exception.type'] = `${type}`;
  if (typeof exception.message === 'string') {
    attributes['exception.message'] = exception.message;
  }
  if (isNativeError(exception) || typeof exception.stack === 'string') {
    attributes['exception.stacktrace'] = `${exception.stack}`;
  }
  return attributes;
}

class Span {
  #name;
  #kind;
  #spanContext;
  #parentSpanContext;
  #startTime;
  #endTime;
  #attributes;
  #events = [];
  #droppedEventsCount = 0;
  #links;
  #droppedLinksCount;
  #status = kUnsetStatus;
  #resource;
  #instrumentationScope;
  #limits;
  #processor;

  constructor(init) {
    this.#name = init.name;
    this.#kind = init.kind;
    this.#spanContext = init.spanContext;
    this.#parentSpanContext = init.parentSpanContext;
    this.#startTime = init.startTime;
    this.#resource = init.resource;
    this.#instrumentationScope = init.instrumentationScope;
    this.#limits = init.limits;
    this.#processor = init.processor;
    this.#attributes = new Attributes(init.limits);
    this.#attributes.setAll(init.attributes);

    const links = [];
    const { linkCountLimit } = init.limits;
    for (let i = 0; i < init.links.length && links.length < linkCountLimit; i++) {
      const link = init.links[i];
      const attributes = new Attributes({
        attributeCountLimit: init.limits.attributePerLinkCountLimit,
        attributeValueLengthLimit: init.limits.attributeValueLengthLimit,
      });
      attributes.setAll(link.attributes);
      ArrayPrototypePush(links, ObjectFreeze({
        context: link.context,
        attributes: attributes.values(),
        droppedAttributesCount: attributes.dropped,
      }));
    }
    this.#links = ObjectFreeze(links);
    this.#droppedLinksCount = init.links.length - links.length;
  }

  spanContext() {
    return this.#spanContext;
  }

  setAttribute(key, value) {
    if (this.#endTime === undefined) this.#attributes.set(key, value);
    return this;
  }

  setAttributes(attributes) {
    if (this.#endTime === undefined) this.#attributes.setAll(attributes);
    return this;
  }

  addEvent(name, attributes, time) {
    validateString(name, 'name');
    if (typeof attributes === 'number' || isDate(attributes)) {
      time = attributes;
      attributes = undefined;
    }
    const timestamp = toTimestamp(time, 'time');
    if (this.#endTime !== undefined) return this;
    if (this.#events.length >= this.#limits.eventCountLimit) {
      this.#droppedEventsCount++;
      return this;
    }
    const eventAttributes = new Attributes({
      attributeCountLimit: this.#limits.attributePerEventCountLimit,
      attributeValueLengthLimit: this.#limits.attributeValueLengthLimit,
    });
    eventAttributes.setAll(attributes);
    ArrayPrototypePush(this.#events, ObjectFreeze({
      name,
      time: timestamp,
      attributes: eventAttributes.values(),
      droppedAttributesCount: eventAttributes.dropped,
    }));
    return this;
  }

  setStatus(status) {
    validateObject(status, 'status');
    const { code, message } = status;
    validateOneOf(code, 'status.code', [
      SpanStatusCode.UNSET,
      SpanStatusCode.OK,
      SpanStatusCode.ERROR,
    ]);
    if (message !== undefined) validateString(message, 'status.message');
    // OK is final, and UNSET never overrides a status that was set.
    if (this.#endTime !== undefined ||
        this.#status.code === SpanStatusCode.OK ||
        code === SpanStatusCode.UNSET) {
      return this;
    }
    this.#status = ObjectFreeze({
      code,
      message: code === SpanStatusCode.ERROR ? message : undefined,
    });
    return this;
  }

  updateName(name) {
    validateString(name, 'name');
    if (this.#endTime === undefined) this.#name = name;
    return this;
  }

  recordException(exception, time) {
    return this.addEvent('exception', exceptionAttributes(exception), time);
  }

  end(endTime) {
    const timestamp = toTimestamp(endTime, 'endTime');
    if (this.#endTime !== undefined) return;
    this.#endTime = timestamp < this.#startTime ? this.#startTime : timestamp;
    this.#processor.onEnd(this);
  }

  isRecording() {
    return this.#endTime === undefined;
  }

  get name() {
    return this.#name;
  }

  get kind() {
    return this.#kind;
  }

  get parentSpanContext() {
    return this.#parentSpanContext;
  }

  get startTime() {
    return this.#startTime;
  }

  get endTime() {
    return this.#endTime;
  }

  get ended() {
    return this.#endTime !== undefined;
  }

  get attributes() {
    return this.#endTime === undefined ?
      this.#attributes.snapshot() : this.#attributes.values();
  }

  get droppedAttributesCount() {
    return this.#attributes.dropped;
  }

  get events() {
    return ObjectFreeze(ArrayPrototypeSlice(this.#events));
  }

  get droppedEventsCount() {
    return this.#droppedEventsCount;
  }

  get links() {
    return this.#links;
  }

  get droppedLinksCount() {
    return this.#droppedLinksCount;
  }

  get status() {
    return this.#status;
  }

  get resource() {
    return this.#resource;
  }

  get instrumentationScope() {
    return this.#instrumentationScope;
  }
}

module.exports = {
  INVALID_SPAN_CONTEXT,
  NonRecordingSpan,
  Span,
  SpanKind,
  SpanStatusCode,
  createSpanContext,
  isSpanContextValid,
};
