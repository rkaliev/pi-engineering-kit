---
name: observability
description: Use when adding or changing logging, metrics, tracing, alerts, timeouts or health checks, or when investigating production behavior from logs and telemetry
---

# Observability

Telemetry must answer three questions without a debugger: what happened to request X, which dependency is slow, and what needs a human now. Follow the project's logger, field names and tools; this skill supplies the rules they don't state.

## Logs

- **Structured, one event per record.** The message is a **fixed string** ("Payment captured", "Couldn't reach provider"); every variable goes into a field. Fixed messages stay searchable and group correctly in error trackers.
- **Levels:**
  - `debug`: development detail, off in production;
  - `info`: a business event that completed ("Order paid"), logged after the commit;
  - `warn`: an expected or recoverable failure ("Couldn't reach provider, retrying");
  - `error`: needs a human, with the reason;
  - `fatal`: only right before an unrecoverable exit.

  A refusal is not a fault: a validation failure, a declined card or a conflict is `info` (writes) or `debug` (reads), not `error`.
- **Fields on every record:** event or message, level, UTC timestamp, service, release version. Add `request_id`, `trace_id` and `job_id` when they exist. Bind them once where the request or job enters, not at every call.
- **Never at info or above:** secrets, tokens, auth headers, card data, personal data, user content, not even masked or truncated. Errors from a database, provider or transport are reduced to their name and code. For payloads, log the length.
- **Log where you handle the error, once.** Rethrow with `cause`; don't log at every layer. Don't log health probes, successful polls or hot loops.

## Correlation

- Create or accept a request id at the entry point and return it to the caller (for example `x-request-id`).
- Propagate trace context across HTTP, queues and jobs (W3C `traceparent`, OpenTelemetry). A job keeps the id of the request that queued it.
- Group errors by a stable identity (operation + error class + code), not by message text, so that one fault is one issue.

## Metrics

- RED for request paths (rate, errors, duration) and USE for resources (utilization, saturation, errors). Names carry units (`_seconds`, `_bytes`, `_total`).
- **Labels come only from small, fixed sets** defined in code: never ids, URLs, e-mails, error messages or anything a user controls. Write down each label's bound.
- Durations are histograms, and percentiles come from summed buckets, never from averaging percentiles. Counters are read as a rate.
- When a value can't be read, report unknown, never a healthy-looking zero.

## Deadlines

- Every wait has a deadline from configuration, and cancellation: database statement and lock timeouts, each outbound call (with an abort signal), queue receives, and UI waits.
- A slow path is fixed, not hidden: raising a timeout to silence an alert is a defect.
- Never race a transaction against a timer. The timer can't cancel a commit, so the result is a double write. Use the database's own timeouts.

## Alerts

- Alert on symptoms a user feels (error rate, latency, a stuck queue), each with a window, a recovery condition and a runbook link.
- Alert when telemetry itself stops (no scrape, no logs, a blind collector): missing data must never read as zero errors.

## Clients: mobile, desktop and POS

Crash reporting with release and device version; breadcrumbs without personal data; a local log buffer that survives offline and uploads later; device health (queue length, last sync, peripheral errors). See mobile-development and pos-systems.

## Investigating from telemetry

- Read-only. Query a bounded window: service, environment, a time range, and a request or trace id when you have one. Start narrow and widen.
- Show the exact query and quote only the fields you need, so someone else can repeat it.
- Never change dashboards, alerts or retention while investigating unless the user asks.

Naming, cardinality budgets, SLI and alert templates and query recipes are in `references/metrics-and-alerts.md`.
