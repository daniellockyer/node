'use strict';

const {
  ArrayFrom,
  ArrayPrototypePush,
  ArrayPrototypeSplice,
  PromisePrototypeThen,
  PromiseReject,
  PromiseResolve,
  SafePromiseAllReturnVoid,
  SafeSet,
} = primordials;

const { AbortSignal } = require('internal/abort_controller');
const { setTimeout, clearTimeout } = require('timers');
const { emitWarning } = require('internal/process/warning');
const { getEnvInteger } = require('internal/otel/config');
const { kSampled } = require('internal/otel/sampler');

let debug = require('internal/util/debuglog').debuglog('otel', (fn) => {
  debug = fn;
});

function getBatchOptions() {
  return {
    scheduleDelay: getEnvInteger('OTEL_BSP_SCHEDULE_DELAY', 5000),
    exportTimeout: getEnvInteger('OTEL_BSP_EXPORT_TIMEOUT', 30000),
    maxQueueSize: getEnvInteger('OTEL_BSP_MAX_QUEUE_SIZE', 2048),
    maxExportBatchSize: getEnvInteger('OTEL_BSP_MAX_EXPORT_BATCH_SIZE', 512),
  };
}

// Buffers ended, sampled spans and hands them to the exporter in batches,
// either when a full batch is available or after the schedule delay.
class BatchSpanProcessor {
  #exporter;
  #options;
  #queue = [];
  #pendingExports = new SafeSet();
  #timer = null;
  #accepting = true;
  #warnedDropped = false;
  #warnedFailed = false;

  constructor(exporter, options = getBatchOptions()) {
    this.#exporter = exporter;
    this.#options = options;
  }

  onStart() {}

  onEnd(span) {
    if (!this.#accepting) return;
    if ((span.spanContext().traceFlags & kSampled) !== kSampled) return;
    if (this.#queue.length >= this.#options.maxQueueSize) {
      if (!this.#warnedDropped) {
        this.#warnedDropped = true;
        emitWarning('Span queue is full; dropping spans until it drains',
                    'OpenTelemetryWarning');
      }
      return;
    }
    ArrayPrototypePush(this.#queue, span);
    if (this.#queue.length >= this.#options.maxExportBatchSize) {
      this.#exportBatch();
    } else {
      this.#scheduleExport();
    }
  }

  hasPendingSpans() {
    return this.#queue.length > 0;
  }

  async forceFlush() {
    this.#cancelScheduledExport();
    while (this.#queue.length > 0) this.#exportBatch();
    await SafePromiseAllReturnVoid(ArrayFrom(this.#pendingExports));
  }

  async shutdown() {
    this.#accepting = false;
    await this.forceFlush();
    await this.#exporter.shutdown?.();
  }

  #scheduleExport() {
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#exportBatch();
    }, this.#options.scheduleDelay);
    this.#timer.unref();
  }

  #cancelScheduledExport() {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  #exportBatch() {
    this.#cancelScheduledExport();
    const batch = ArrayPrototypeSplice(this.#queue, 0, this.#options.maxExportBatchSize);
    if (batch.length === 0) return;
    const signal = AbortSignal.timeout(this.#options.exportTimeout);
    let result;
    try {
      result = PromiseResolve(this.#exporter.export(batch, { signal }));
    } catch (error) {
      result = PromiseReject(error);
    }
    const pending = PromisePrototypeThen(result, undefined, (error) => {
      debug('export of %d spans failed: %s', batch.length, error);
      if (!this.#warnedFailed) {
        this.#warnedFailed = true;
        emitWarning(`Failed to export spans: ${error?.message ?? error}`,
                    'OpenTelemetryWarning');
      }
    });
    this.#pendingExports.add(pending);
    PromisePrototypeThen(pending, () => this.#pendingExports.delete(pending));
    if (this.#queue.length > 0) this.#scheduleExport();
  }
}

module.exports = {
  BatchSpanProcessor,
};
