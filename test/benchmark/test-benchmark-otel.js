'use strict';

require('../common');

const runBenchmark = require('../common/benchmark');

runBenchmark('otel', { NODEJS_BENCHMARK_ZERO_ALLOWED: 1 });
