# State and data in the UI

These rules hold for any client (web, mobile, desktop); the examples use web terms. Follow the project's state manager and data layer; these rules decide what goes where inside it.

## Where state lives

Take the first place that works:

1. **Derive it** from state that already exists. A value you can compute is never stored.
2. **Server cache** (the data-fetching layer: React Query, SWR, Apollo, a repository with a cache). Server data is not copied into a second store, where it goes stale.
3. **The URL** for anything shareable or restorable: filters, tabs, the selected item, pagination. On mobile, the equivalent is the navigation state and deep links.
4. **Persisted preferences** (cookie, storage, DataStore/UserDefaults) for what must survive a restart.
5. **Shared context/scope** for state several distant components need; split it by how often it changes.
6. **Local component state** for everything else, in the lowest component that needs it.

Don't sync one state into another with effects. If two values must agree, derive one from the other.

## Server cache

- One place sets the cache defaults: how long data stays fresh and the retry policy. A 4xx is never retried (the same request gets the same answer); other failures retry once or twice.
- A query's key and fetcher come from one function (`queryOptions` in TanStack Query, or the typed API client's helpers) that the prefetch or route loader and the component both use, so the keys can't drift.
- Every mutation updates or invalidates the queries whose data it changed. Where the stack has a lint rule for it, CI runs it.
- Server rendering creates a new query client for each request: a shared one leaks one user's data into another's page.
- Query and mutation errors reach one reporting path (the cache-level error handler), not a catch in each component.
- The cache dev tools load only in development builds.

## Optimistic updates

- **Paint first, reconcile when the server answers.** The optimistic change mirrors the server's logic exactly (including rounding and ordering), so reconciling doesn't make the UI jump.
- **A rollback is never silent.** When the write fails, restore the previous state and tell the user what didn't happen and what they can do.
- **Overlapping writes** to the same thing are serialized or share one scope, and only the last one refetches.
- **Money is never optimistic.** A call that takes a payment, and the read that reports its status, show a real pending state and the server's answer (payments-and-money).
- **A write that doesn't paint says so:** a visible pending state on the control, never an unexplained pause.
- After an optimistic paint, nothing spins.

## Real content, not placeholders

- When the data is available (server-rendered, cached, passed in), render it; don't show a skeleton or spinner first.
- A wrong default is worse than a loading state: "0 items" before the data arrives is a false claim. Render the default only when you know it is true.
- A loading state has the content's own shape (a skeleton of the list), not a spinner in an empty box.

## Deterministic output

- Formatting of dates and times names its time zone explicitly; the server and the client, and two users, must not see different values by accident.
- Server-rendered and client-rendered output is the same tree. Browser-only APIs are read after hydration, behind one named guard, not with ad-hoc `typeof window` branches.
- Numbers, currency and dates go through the locale-aware formatters with an explicit locale.

## Client and server boundary

In a repo that holds both client and server code, server-only libraries (database clients, secrets, server validation) stay out of the client by tooling, not by review:
- a lint import rule forbids importing them in client code (type-only imports allowed where the tool supports it);
- a build-time import guard fails the build on a leak;
- a CI check fails if a server-only marker is found in the built bundle.
