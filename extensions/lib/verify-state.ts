/**
 * The verify gate's state, shared between extensions in one pi process: the guard reads it to count
 * a review only when it ran on verified code.
 */
export const verifyState = { unverified: false };
