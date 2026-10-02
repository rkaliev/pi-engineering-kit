---
name: backend-services
description: Use when building or changing a server-side service, API, worker or scheduled job, its configuration, startup and shutdown, packaging or deployment
---

# Backend services

A service is easy to run when any instance can start, serve and die at any moment without losing work, and the same build runs everywhere with only its configuration changed. Follow the project's framework and platform; these rules hold on any of them. Logging and metrics are in observability, and schema changes in database-changes.

## Configuration

- **One typed config module is the only code that reads the environment.** Everything else imports typed values from it.
- It validates the whole shape **once, at startup**, and the service refuses to start on a missing or invalid value, naming the variable (never printing its value).
- Operational parameters (timeouts, limits, pool sizes, retry counts) are configuration too, with defaults in that module, not literals scattered in code.
- Secrets come from the platform's secret store at runtime. Never bake them into the image, build arguments, the client bundle or the repo.
- `.env.example` lists every variable with a comment and no real values.

## Build, release, run

- Build one artifact once (image, jar, binary) and promote the same artifact through every environment. Only the configuration differs.
- Every release carries its version (commit SHA or tag) and reports it in logs and in the health response.
- If a build argument is required for the artifact to work, a missing one fails the build. A build that starts and silently does nothing is the worse outcome.

## Processes

- **Stateless:** local memory and disk are caches at most. Sessions, uploads, queues and locks live in backing services, and there are no sticky sessions.
- Scale by running more processes. Separate the process types (web, worker, scheduler) so each scales and fails on its own.
- A scheduled job runs exactly once per tick across instances: use a lock, a leader election or the platform's scheduler.

## Backing services

Databases, caches, queues, e-mail and payment providers are attached through configuration (a URL and credentials) and can be swapped without a code change. Each call has a timeout, and each dependency is part of readiness (observability).

## Start and stop

- Listen on the port from configuration. Start fast: no long work before the service is ready.
- **Liveness** means the process is alive; it never checks dependencies, or a slow database restarts everything. **Readiness** means the service can take traffic now: dependencies reachable, and the schema at the version this build needs (database-changes).
- **On SIGTERM:**
  - stop accepting new work and report not ready;
  - finish in-flight requests and jobs within a deadline from configuration;
  - close the pools and flush the logs;
  - exit 0, or exit non-zero if the deadline passed.
- Work survives a sudden kill: jobs are idempotent and resumable, and messages are acknowledged only after they are processed.

## One store until measured

Start with the Postgres the service already has:

- a queue with `FOR UPDATE SKIP LOCKED`;
- a cache table or materialized view;
- advisory locks for scheduled jobs and mutual exclusion.

Add a separate broker or cache only after a measurement or a hard need (a throughput limit, a feature Postgres lacks). Record it in a decision record (writing-documentation), with the measurement.

## Parity

Run the same kinds of backing services locally and in CI as in production: a Postgres container instead of SQLite, the real broker instead of an in-memory fake. Keep the gap between merge and deploy short.

## Logs and one-off tasks

- Write logs to stdout and stderr as an event stream. Routing, storage and rotation belong to the platform (observability).
- Migrations, backfills and data fixes run as commands from the same release and configuration, and they are committed to the repo. Never type them into a production console. Anything destructive or outward-facing needs the user's yes.

## API contracts

- The contract (OpenAPI, protobuf, GraphQL schema) is the source of truth, checked in CI against the code or generated from it.
- Changes are backward compatible: add fields, never repurpose them. A breaking change gets a new version, and the old one gets a deprecation period and a note in the changelog.
- Every mutating endpoint that a client may retry accepts an idempotency key (see payments-and-money).
