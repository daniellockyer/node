'use strict';

const {
  ArrayIsArray,
  ArrayPrototypeMap,
  ObjectFreeze,
  ObjectKeys,
  ObjectPrototypeHasOwnProperty,
  StringPrototypeSlice,
} = primordials;

function isPrimitiveValue(value) {
  const type = typeof value;
  return type === 'string' || type === 'number' || type === 'boolean';
}

// Attribute values are strings, numbers, booleans, or arrays whose non-null
// elements share one of those types. Invalid values are dropped rather than
// thrown on, so that instrumentation never breaks the instrumented code.
function isValidAttributeValue(value) {
  if (isPrimitiveValue(value)) return true;
  if (!ArrayIsArray(value)) return false;
  let elementType;
  for (let i = 0; i < value.length; i++) {
    const element = value[i];
    if (element === null || element === undefined) continue;
    if (!isPrimitiveValue(element)) return false;
    const type = typeof element;
    elementType ??= type;
    if (type !== elementType) return false;
  }
  return true;
}

function truncate(value, lengthLimit) {
  if (typeof value === 'string') {
    return value.length > lengthLimit ?
      StringPrototypeSlice(value, 0, lengthLimit) : value;
  }
  if (ArrayIsArray(value)) {
    return ObjectFreeze(ArrayPrototypeMap(value, (element) => truncate(element, lengthLimit)));
  }
  return value;
}

// A bounded collection of attributes that counts what it drops.
class Attributes {
  #values = {};
  #count = 0;
  #countLimit;
  #lengthLimit;
  dropped = 0;

  constructor(limits) {
    this.#countLimit = limits.attributeCountLimit;
    this.#lengthLimit = limits.attributeValueLengthLimit;
  }

  set(key, value) {
    if (typeof key !== 'string' || key.length === 0 || key === '__proto__' ||
        !isValidAttributeValue(value)) {
      return;
    }
    if (!ObjectPrototypeHasOwnProperty(this.#values, key)) {
      if (this.#count >= this.#countLimit) {
        this.dropped++;
        return;
      }
      this.#count++;
    }
    this.#values[key] = truncate(value, this.#lengthLimit);
  }

  setAll(attributes) {
    if (attributes === null || typeof attributes !== 'object') return;
    const keys = ObjectKeys(attributes);
    for (let i = 0; i < keys.length; i++) {
      this.set(keys[i], attributes[keys[i]]);
    }
  }

  get(key) {
    return this.#values[key];
  }

  // Returns a copy that is unaffected by later changes.
  snapshot() {
    return { ...this.#values };
  }

  // Returns the backing object. Only for collections that no longer change.
  values() {
    return this.#values;
  }
}

module.exports = {
  Attributes,
  isValidAttributeValue,
};
