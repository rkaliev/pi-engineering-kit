/**
 * The verify gate's state, shared between extensions in one pi process: the guard reads it to count
 * a review only when it ran on verified code. pi loads each extension in its own module graph, so a
 * module-level object would be one copy per extension; the state lives on `globalThis` instead.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GuardBaseline } from "./scope.ts";
import type { Tree } from "./worktree.ts";

const KEY = Symbol.for("pi-engineering-kit.verifyState");
/** Also shared: the workspace parts the verify gate found slow, and the guard's session baseline (lib/scope.ts). */
interface SharedState {
	unverified: boolean;
	slowParts: string[];
	guardBaseline?: GuardBaseline;
	/**
	 * The verify gate's check that unverified edits brought the tree back to content the checks passed on; the guard runs it
	 * before calling a review Inconclusive. Returns the fingerprint it credited on, or `undefined`.
	 */
	creditByContent?: (ctx: ExtensionContext) => Tree | undefined;
}
const store = globalThis as typeof globalThis & { [KEY]?: SharedState };

export const verifyState: SharedState = (store[KEY] ??= { unverified: false, slowParts: [] });
verifyState.slowParts ??= [];
