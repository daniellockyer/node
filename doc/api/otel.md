# OpenTelemetry

<!--introduced_in=REPLACEME-->

<!-- YAML
added: REPLACEME
-->

> Stability: 1.0 - Early development. Enable this API with the
> [`--experimental-otel`][] CLI flag.

<!-- source_link=lib/otel.js -->

The `node:otel` module provides a built-in [OpenTelemetry][] tracing SDK.

To access it:

```mjs
import otel from 'node:otel';
```

```cjs
const otel = require('node:otel');
```

This module is only available under the `node:` scheme.

[OpenTelemetry]: https://opentelemetry.io/
[`--experimental-otel`]: cli.md#--experimental-otel
