# Metrics, alerts and queries

## Naming

- `<domain>_<thing>_<unit>`: `http_server_request_duration_seconds`, `payment_capture_total`, `queue_depth`.
- Counters end in `_total`; durations are histograms in seconds; sizes in bytes.
- Follow OpenTelemetry semantic conventions where the project uses them (`http.route`, `db.system`, `messaging.system`).

## Cardinality budget

Keep a table next to the metric definitions and update it with every new label:

| Metric | Label | Allowed values | Bound |
|---|---|---|---|
| `http_server_request_duration_seconds` | `route` | route templates (`/orders/:id`), never raw paths | ~50 |
| | `status_class` | `2xx`, `3xx`, `4xx`, `5xx` | 4 |
| `payment_capture_total` | `provider` | configured providers | ~5 |
| | `outcome` | `captured`, `declined`, `unknown` | 3 |

Never: user, tenant, order, request or trace ids; URLs; e-mails; error messages.

## Histogram buckets

Pick buckets around the target and the ceiling, for example `0.05, 0.1, 0.25, 0.5, 1, 2, 5` seconds for an API with a 2-second ceiling. A target (where an operation should finish) and a ceiling (a failure line above p99) are different numbers; name both.

## SLI and alert template

```markdown
### <Alert name>
- Signal: <query, e.g. rate of 5xx / all requests over 5m, probes excluded>
- Fires when: <threshold> for <window>; severity: <page | ticket>
- Recovers when: <condition>
- Why it matters: <user impact>
- Runbook: first look at <dashboard or query>; likely causes; safe actions; what never to do (raise pool size or timeouts just to clear it)
```

Include alerts for lost telemetry: no scrape for N minutes, no logs ingested, a collector reporting failure.

## Query recipes

Adapt to the project's log store (Loki LogQL, Elasticsearch, CloudWatch Insights, Datadog, VictoriaLogs):
- **One request:** filter by `request_id`, sort by time, show `level, event, err_name, err_code`.
- **One trace across services:** filter by `trace_id`.
- **After a deploy:** filter by `version = <release>` and level ≥ warn, grouped by `event`.
- **Top errors:** level = error over the last hour, grouped by error identity (operation, class, code), counted.
- **Unparsed lines:** records missing `level` or `event`, which point at a broken logger.
