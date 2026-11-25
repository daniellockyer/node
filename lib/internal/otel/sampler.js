'use strict';

const {
  BigInt,
  MathFloor,
  StringPrototypeSlice,
} = primordials;

const {
  codes: {
    ERR_INVALID_ARG_VALUE,
  },
} = require('internal/errors');
const { validateNumber } = require('internal/validators');

const kSampled = 0x01;
const kSamplerNames = [
  'always_on',
  'always_off',
  'traceidratio',
  'parentbased_always_on',
  'parentbased_always_off',
  'parentbased_traceidratio',
];

class AlwaysOnSampler {
  shouldSample() {
    return true;
  }
}

class AlwaysOffSampler {
  shouldSample() {
    return false;
  }
}

// Samples a deterministic fraction of traces by comparing the trailing 56 bits
// of the trace ID against a threshold, so that every participant using the same
// ratio makes the same decision for a trace.
class TraceIdRatioSampler {
  #threshold;

  constructor(ratio) {
    this.#threshold = BigInt(MathFloor(ratio * 2 ** 56));
  }

  shouldSample(parent, traceId) {
    return BigInt(`0x${StringPrototypeSlice(traceId, 18)}`) < this.#threshold;
  }
}

class ParentBasedSampler {
  #root;

  constructor(root) {
    this.#root = root;
  }

  shouldSample(parent, traceId) {
    if (parent === undefined) return this.#root.shouldSample(parent, traceId);
    return (parent.traceFlags & kSampled) === kSampled;
  }
}

function createSampler(name, arg) {
  switch (name) {
    case 'always_on':
      return new AlwaysOnSampler();
    case 'always_off':
      return new AlwaysOffSampler();
    case 'traceidratio':
      return new TraceIdRatioSampler(validateRatio(arg));
    case 'parentbased_always_on':
      return new ParentBasedSampler(new AlwaysOnSampler());
    case 'parentbased_always_off':
      return new ParentBasedSampler(new AlwaysOffSampler());
    case 'parentbased_traceidratio':
      return new ParentBasedSampler(new TraceIdRatioSampler(validateRatio(arg)));
    default:
      throw new ERR_INVALID_ARG_VALUE('options.sampler', name);
  }
}

function validateRatio(ratio) {
  ratio ??= 1;
  validateNumber(ratio, 'options.samplerArg', 0, 1);
  return ratio;
}

module.exports = {
  kSampled,
  kSamplerNames,
  createSampler,
};
