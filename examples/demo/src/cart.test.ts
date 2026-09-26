import assert from "node:assert/strict";
import test from "node:test";
import { cartTotalMinor } from "./cart.ts";

test("sums price × quantity in minor units", () => {
	assert.equal(cartTotalMinor([{ priceMinor: 1999, quantity: 2 }, { priceMinor: 1, quantity: 3 }]), 4001);
	assert.equal(cartTotalMinor([]), 0);
});

test("rejects fractional or negative amounts", () => {
	assert.throws(() => cartTotalMinor([{ priceMinor: 19.99, quantity: 1 }]), RangeError);
	assert.throws(() => cartTotalMinor([{ priceMinor: 100, quantity: -1 }]), RangeError);
});
