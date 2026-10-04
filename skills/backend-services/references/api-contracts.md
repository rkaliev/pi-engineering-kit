# API contracts: internal RPC, errors and access

These add to the skill's "API contracts" rules.

## Internal typed RPC

An RPC between a web client and its own server (tRPC, server functions, a generated client) is still a contract. After a deploy, open tabs keep running the old client for hours.

- Removing or renaming a procedure, or tightening its input (a new required field, a narrower type), is deprecated first and removed a release later.
- Adding an optional input field or a new output field is safe.
- Third parties and long-lived clients (mobile apps, partners) get a versioned API (`/api/<name>/v1`) with its schema generated from the same validation code, not the internal RPC.

## Errors

- An error carries a stable machine-readable code (`SLOT_TAKEN`, `LIMIT_REACHED`) that clients branch on. The message is for people and may change.
- Server errors (5xx) are reported with the request id and without the input or session; client errors (4xx) are expected and are not alerts.

## Access checks

- Role checks (signed in, admin) may run in middleware.
- A check on a specific resource (this organization, this order) runs after the input is validated, in the handler or a helper it calls, because middleware runs before the input is parsed.
- Every handler that takes a resource id has a test that sends another tenant's id and expects a refusal.
