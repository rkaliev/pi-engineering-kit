/**
 * The verify gate's state, shared between extensions in one pi process: the guard reads it to count
 * a review only when it ran on verified code. pi loads each extension in its own module graph, so a
 * module-level object would be one copy per extension; the state lives on `globalThis` instead.
 */
const KEY = Symbol.for("pi-engineering-kit.verifyState");
const store = globalThis as typeof globalThis & { [KEY]?: { unverified: boolean } };

export const verifyState: { unverified: boolean } = (store[KEY] ??= { unverified: false });
