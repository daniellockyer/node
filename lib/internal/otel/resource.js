'use strict';

const {
  ObjectFreeze,
  StringPrototypeSlice,
} = primordials;

const { Attributes } = require('internal/otel/attributes');
const { getEnv, getEnvKeyValueList } = require('internal/otel/config');

const kResourceLimits = {
  attributeCountLimit: 128,
  attributeValueLengthLimit: Infinity,
};

// Precedence, lowest first: SDK defaults, OTEL_RESOURCE_ATTRIBUTES,
// OTEL_SERVICE_NAME, options.resource, options.serviceName.
function createResource(options) {
  const attributes = new Attributes(kResourceLimits);
  const version = StringPrototypeSlice(process.version, 1);
  attributes.set('service.name', `unknown_service:${process.release.name}`);
  attributes.set('telemetry.sdk.name', 'node');
  attributes.set('telemetry.sdk.language', 'nodejs');
  attributes.set('telemetry.sdk.version', version);
  attributes.set('process.pid', process.pid);
  attributes.set('process.runtime.name', process.release.name);
  attributes.set('process.runtime.version', version);
  attributes.setAll(getEnvKeyValueList('OTEL_RESOURCE_ATTRIBUTES'));
  const envServiceName = getEnv('OTEL_SERVICE_NAME');
  if (envServiceName !== undefined) attributes.set('service.name', envServiceName);
  attributes.setAll(options.resource);
  if (options.serviceName !== undefined) attributes.set('service.name', options.serviceName);
  return ObjectFreeze({
    __proto__: null,
    attributes: attributes.values(),
    droppedAttributesCount: attributes.dropped,
  });
}

module.exports = {
  createResource,
};
