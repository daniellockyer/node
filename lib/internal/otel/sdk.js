'use strict';

const {
  ArrayPrototypeIncludes,
  ArrayPrototypePush,
  ObjectKeys,
} = primordials;

const {
  codes: {
    ERR_INVALID_STATE,
  },
} = require('internal/errors');
const {
  getEnv,
  getEnvBoolean,
  getEnvNumber,
  getSpanLimits,
  warnInvalid,
} = require('internal/otel/config');
const { OTLPHttpJsonExporter } = require('internal/otel/exporters/otlp_http');
const { BatchSpanProcessor } = require('internal/otel/processor');
const { createResource } = require('internal/otel/resource');
const { createSampler, kSamplerNames } = require('internal/otel/sampler');
const {
  TracerProvider,
  getActiveProvider,
  setActiveProvider,
} = require('internal/otel/tracer');
const { kEmptyObject } = require('internal/util');
const {
  validateBoolean,
  validateFunction,
  validateObject,
  validateOneOf,
  validateString,
} = require('internal/validators');

const kInstrumentations = {
  __proto__: null,
  http: 'internal/otel/instrumentations/http',
  fetch: 'internal/otel/instrumentations/fetch',
};
const kDefaultSampler = 'parentbased_always_on';

let enabledInstrumentations = [];

function validateExporter(exporter) {
  validateObject(exporter, 'options.exporter');
  validateFunction(exporter.export, 'options.exporter.export');
  if (exporter.shutdown !== undefined) {
    validateFunction(exporter.shutdown, 'options.exporter.shutdown');
  }
}

function resolveInstrumentations(option) {
  if (option !== undefined) validateObject(option, 'options.instrumentations');
  const names = [];
  const keys = ObjectKeys(kInstrumentations);
  for (let i = 0; i < keys.length; i++) {
    const enabled = option?.[keys[i]] ?? true;
    validateBoolean(enabled, `options.instrumentations.${keys[i]}`);
    if (enabled) ArrayPrototypePush(names, keys[i]);
  }
  return names;
}

function resolveSampler(options) {
  let { sampler, samplerArg } = options;
  if (sampler === undefined) {
    sampler = getEnv('OTEL_TRACES_SAMPLER') ?? kDefaultSampler;
    if (!ArrayPrototypeIncludes(kSamplerNames, sampler)) {
      warnInvalid('OTEL_TRACES_SAMPLER', sampler);
      sampler = kDefaultSampler;
    }
  } else {
    validateOneOf(sampler, 'options.sampler', kSamplerNames);
  }
  if (samplerArg === undefined) {
    samplerArg = getEnvNumber('OTEL_TRACES_SAMPLER_ARG');
    if (samplerArg !== undefined && !(samplerArg >= 0 && samplerArg <= 1)) {
      warnInvalid('OTEL_TRACES_SAMPLER_ARG', samplerArg);
      samplerArg = undefined;
    }
  }
  return createSampler(sampler, samplerArg);
}

function onBeforeExit() {
  const provider = getActiveProvider();
  if (provider?.hasPendingSpans()) provider.forceFlush();
}

function start(options = kEmptyObject) {
  validateObject(options, 'options');
  if (getActiveProvider() !== null) {
    throw new ERR_INVALID_STATE('OpenTelemetry tracing has already been started');
  }
  const { serviceName, resource, exporter, endpoint, headers } = options;
  if (serviceName !== undefined) validateString(serviceName, 'options.serviceName');
  if (resource !== undefined) validateObject(resource, 'options.resource');
  if (endpoint !== undefined) validateString(endpoint, 'options.endpoint');
  if (exporter !== undefined) validateExporter(exporter);
  const instrumentations = resolveInstrumentations(options.instrumentations);
  const sampler = resolveSampler(options);

  if (getEnvBoolean('OTEL_SDK_DISABLED')) return;

  const provider = new TracerProvider({
    resource: createResource(options),
    sampler,
    limits: getSpanLimits(),
    processor: new BatchSpanProcessor(
      exporter ?? new OTLPHttpJsonExporter({ endpoint, headers })),
  });
  setActiveProvider(provider);
  for (let i = 0; i < instrumentations.length; i++) {
    require(kInstrumentations[instrumentations[i]]).enable();
  }
  enabledInstrumentations = instrumentations;
  process.on('beforeExit', onBeforeExit);
}

async function stop() {
  const provider = getActiveProvider();
  if (provider === null) return;
  for (let i = 0; i < enabledInstrumentations.length; i++) {
    require(kInstrumentations[enabledInstrumentations[i]]).disable();
  }
  enabledInstrumentations = [];
  setActiveProvider(null);
  process.removeListener('beforeExit', onBeforeExit);
  await provider.shutdown();
}

async function flush() {
  await getActiveProvider()?.forceFlush();
}

module.exports = {
  flush,
  start,
  stop,
};
