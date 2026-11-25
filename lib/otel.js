'use strict';

// Public entry point for the OpenTelemetry tracing SDK.
// Usage: require('node:otel')
// Requires: --experimental-otel

const {
  ObjectFreeze,
} = primordials;

const { emitExperimentalWarning } = require('internal/util');
emitExperimentalWarning('otel');

module.exports = ObjectFreeze({
  __proto__: null,
});
