'use strict';

// Public entry point for the OpenTelemetry tracing SDK.
// Usage: require('node:otel')
// Requires: --experimental-otel

const {
  ObjectFreeze,
} = primordials;

const { emitExperimentalWarning } = require('internal/util');
emitExperimentalWarning('otel');

const {
  ROOT_CONTEXT,
  active,
  bind,
  createContextKey,
  getActiveSpan,
  getSpan,
  setSpan,
  withContext,
} = require('internal/otel/context');
const { InMemorySpanExporter } = require('internal/otel/exporters/memory');
const { extract, inject } = require('internal/otel/propagation');
const { flush, start, stop } = require('internal/otel/sdk');
const {
  SpanKind,
  SpanStatusCode,
  isSpanContextValid,
} = require('internal/otel/span');
const { getTracer } = require('internal/otel/tracer');

const context = ObjectFreeze({
  __proto__: null,
  active,
  bind,
  with: withContext,
});

const trace = ObjectFreeze({
  __proto__: null,
  getActiveSpan,
  getSpan,
  isSpanContextValid,
  setSpan,
});

const propagation = ObjectFreeze({
  __proto__: null,
  extract,
  inject,
});

module.exports = {
  start,
  stop,
  flush,
  getTracer,
  context,
  trace,
  propagation,
  createContextKey,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  InMemorySpanExporter,
};
