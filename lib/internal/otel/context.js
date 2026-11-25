'use strict';

const {
  ReflectApply,
  SafeMap,
  Symbol,
} = primordials;

const { AsyncLocalStorage } = require('async_hooks');
const {
  codes: {
    ERR_INVALID_ARG_TYPE,
  },
} = require('internal/errors');
const { validateFunction } = require('internal/validators');

class Context {
  #values;

  constructor(values) {
    this.#values = values;
  }

  getValue(key) {
    return this.#values.get(key);
  }

  setValue(key, value) {
    const values = new SafeMap(this.#values);
    values.set(key, value);
    return new Context(values);
  }

  deleteValue(key) {
    if (!this.#values.has(key)) return this;
    const values = new SafeMap(this.#values);
    values.delete(key);
    return new Context(values);
  }
}

const ROOT_CONTEXT = new Context(new SafeMap());
const kSpanKey = Symbol('otel.span');
const kSuppressTracingKey = Symbol('otel.suppress_tracing');

const storage = new AsyncLocalStorage();

function createContextKey(description) {
  return Symbol(description);
}

function validateContext(value, name) {
  if (!(value instanceof Context)) {
    throw new ERR_INVALID_ARG_TYPE(name, 'Context', value);
  }
}

function active() {
  return storage.getStore() ?? ROOT_CONTEXT;
}

function withContext(context, fn, thisArg, ...args) {
  validateContext(context, 'context');
  validateFunction(fn, 'fn');
  return storage.run(context, ReflectApply, fn, thisArg, args);
}

function bind(context, fn) {
  validateContext(context, 'context');
  validateFunction(fn, 'fn');
  return function bound(...args) {
    return storage.run(context, ReflectApply, fn, this, args);
  };
}

function getSpan(context) {
  validateContext(context, 'context');
  return context.getValue(kSpanKey);
}

function setSpan(context, span) {
  validateContext(context, 'context');
  return context.setValue(kSpanKey, span);
}

function getActiveSpan() {
  return active().getValue(kSpanKey);
}

function suppressTracing(context) {
  return context.setValue(kSuppressTracingKey, true);
}

function isTracingSuppressed(context) {
  return context.getValue(kSuppressTracingKey) === true;
}

module.exports = {
  Context,
  ROOT_CONTEXT,
  active,
  bind,
  createContextKey,
  getActiveSpan,
  getSpan,
  isTracingSuppressed,
  setSpan,
  storage,
  suppressTracing,
  validateContext,
  withContext,
};
