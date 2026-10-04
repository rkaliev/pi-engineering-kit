# Feature flags and experiments

A flag decouples deploy from release: code ships dark and is turned on, ramped or killed without a deploy. It is runtime configuration with an owner and an end date, not a permanent branch in the code.

## Choosing the system

- The application talks to flags through **OpenFeature** (the CNCF standard API with server and web SDKs), so the provider can change without touching call sites.
- The provider is a stack decision (choosing-a-stack): a self-hosted one (flagd, Unleash, GrowthBook, Flagsmith) or a SaaS. Write your own service only with a recorded reason a provider can't meet; it then owes everything below, including the audit log.
- A config value that never changes at runtime is configuration (backend-services), not a flag.

## Definitions live in code

- One typed registry in the repo names every flag: key, value type, default, owner, kind (release, experiment, ops kill switch, permission) and, for release and experiment flags, a removal date. Call sites use the registry's typed keys, never string literals.
- Runtime state (on/off, rules, rollout percentage) lives in the flag system. A deploy creates missing flags in their default state and never changes an existing one's state.
- **Removing a flag:** ship the winning branch, delete the definition so the compiler finds every call site, then delete the flag in the system. A flag past its removal date is a follow-up, not a feature.

## Defaults and failure

- Every flag has a **safe default**: the value the product must have when the flag system is unreachable. A kill switch defaults to the safe state; a paid feature defaults to off; "pause billing" defaults to paused if charging by mistake is worse than not charging.
- Evaluation never throws and never blocks a request for long: a timeout (hundreds of milliseconds), then the defaults, then a log and a metric. A circuit breaker stops calling a provider that keeps failing.
- Serve the last good rule set when the source is down, and expose its age as a metric.

## Targeting and assignment

- The evaluation context is a closed, documented list of attributes (user id, tenant, role, platform, app version, locale). No raw personal data: send an email domain, not the address. Never log the context.
- Bucketing is deterministic: a stable hash of `<flag key>:<identity>` into fixed buckets, so a user's assignment doesn't change between requests, replicas or deploys. Pin it with a test of known identities and their buckets; a change to that test is a breaking change.
- Ramp a rollout by widening the range, so only the newly included users change. Anonymous users get a stable anonymous id; an experiment that must survive sign-in stores the assignment and carries it over.
- Rules match on missing attributes as "no match" (fail closed), and avoid regex operators on user input.

## Delivery to clients

- Evaluate on the server and hand the result to the client with the first render (server-rendered state or the bootstrap payload), so the UI doesn't flash from one variant to the other.
- Send the client only the flags it uses; server-only flags (limits, kill switches for internal systems) never reach the browser or app.
- A mobile or desktop client caches the last values and starts from them offline.

## Changes, audit and access

- Every change records who, when, what and why (the provider's audit log or your own). Changing a flag in production is an outward-facing action: the agent proposes it; the user does it.
- Separate who may operate a flag (toggle, ramp) from who may change its definition or targeting.

## Experiments

- Log an **exposure** event when the user actually sees the variant, not when they are assigned; analyse on exposures.
- Tag product events with the experiment and variant. Check the sample ratio (SRM) before reading results, and set guardrail metrics (errors, latency, revenue) up front.
- Stop rules are decided before the start, not by peeking until the result looks good.

## Testing

- Unit tests take the flag values as input (an in-memory OpenFeature provider or the registry defaults), never a call to the real system.
- Test both sides of every live flag, and the defaults path: the product works with the flag system down.
- An end-to-end scenario sets its flags through the test provider or an override that is impossible in production.
