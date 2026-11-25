'use strict';

const {
  ArrayPrototypePushApply,
  ArrayPrototypeSlice,
  PromiseResolve,
} = primordials;

class InMemorySpanExporter {
  #spans = [];

  export(spans) {
    ArrayPrototypePushApply(this.#spans, spans);
    return PromiseResolve();
  }

  getFinishedSpans() {
    return ArrayPrototypeSlice(this.#spans);
  }

  reset() {
    this.#spans = [];
  }

  shutdown() {
    return PromiseResolve();
  }
}

module.exports = {
  InMemorySpanExporter,
};
