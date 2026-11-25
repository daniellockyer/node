'use strict';

const {
  ArrayPrototypeForEach,
  NumberIsNaN,
  NumberIsSafeInteger,
  NumberParseFloat,
  NumberParseInt,
  RegExpPrototypeExec,
  StringPrototypeIndexOf,
  StringPrototypeSlice,
  StringPrototypeSplit,
  StringPrototypeToLowerCase,
  StringPrototypeTrim,
  decodeURIComponent,
} = primordials;

const { emitWarning } = require('internal/process/warning');

const kIntegerRegExp = /^[0-9]+$/;

function getEnv(name) {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = StringPrototypeTrim(value);
  return trimmed === '' ? undefined : trimmed;
}

function warnInvalid(name, value) {
  emitWarning(`Ignoring invalid value ${value} for ${name}`, 'OpenTelemetryWarning');
}

function getEnvInteger(name, defaultValue) {
  const value = getEnv(name);
  if (value === undefined) return defaultValue;
  if (RegExpPrototypeExec(kIntegerRegExp, value) === null) {
    warnInvalid(name, value);
    return defaultValue;
  }
  const number = NumberParseInt(value, 10);
  if (!NumberIsSafeInteger(number)) {
    warnInvalid(name, value);
    return defaultValue;
  }
  return number;
}

function getEnvNumber(name) {
  const value = getEnv(name);
  if (value === undefined) return undefined;
  const number = NumberParseFloat(value);
  if (NumberIsNaN(number)) {
    warnInvalid(name, value);
    return undefined;
  }
  return number;
}

function getEnvBoolean(name) {
  const value = getEnv(name);
  if (value === undefined) return false;
  const lower = StringPrototypeToLowerCase(value);
  if (lower === 'true') return true;
  if (lower !== 'false') warnInvalid(name, value);
  return false;
}

function decode(name, value) {
  try {
    return decodeURIComponent(value);
  } catch {
    warnInvalid(name, value);
    return undefined;
  }
}

// Parses the `key1=value1,key2=value2` lists used by OTEL_RESOURCE_ATTRIBUTES
// and OTEL_EXPORTER_OTLP_HEADERS. Keys and values are percent-decoded.
function getEnvKeyValueList(name) {
  const result = { __proto__: null };
  const value = getEnv(name);
  if (value === undefined) return result;
  ArrayPrototypeForEach(StringPrototypeSplit(value, ','), (entry) => {
    const index = StringPrototypeIndexOf(entry, '=');
    if (index === -1) {
      warnInvalid(name, entry);
      return;
    }
    const key = decode(name, StringPrototypeTrim(StringPrototypeSlice(entry, 0, index)));
    const val = decode(name, StringPrototypeTrim(StringPrototypeSlice(entry, index + 1)));
    if (key === undefined || val === undefined || key === '') return;
    result[key] = val;
  });
  return result;
}

function getSpanLimits() {
  const attributeCountLimit = getEnvInteger(
    'OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT',
    getEnvInteger('OTEL_ATTRIBUTE_COUNT_LIMIT', 128));
  const attributeValueLengthLimit = getEnvInteger(
    'OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT',
    getEnvInteger('OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT', Infinity));
  return {
    attributeCountLimit,
    attributeValueLengthLimit,
    eventCountLimit: getEnvInteger('OTEL_SPAN_EVENT_COUNT_LIMIT', 128),
    linkCountLimit: getEnvInteger('OTEL_SPAN_LINK_COUNT_LIMIT', 128),
    attributePerEventCountLimit:
      getEnvInteger('OTEL_EVENT_ATTRIBUTE_COUNT_LIMIT', attributeCountLimit),
    attributePerLinkCountLimit:
      getEnvInteger('OTEL_LINK_ATTRIBUTE_COUNT_LIMIT', attributeCountLimit),
  };
}

module.exports = {
  getEnv,
  getEnvBoolean,
  getEnvInteger,
  getEnvKeyValueList,
  getEnvNumber,
  getSpanLimits,
  warnInvalid,
};
