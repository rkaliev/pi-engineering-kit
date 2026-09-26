export interface CartItem {
	/** Unit price in minor units (cents, kopecks). */
	priceMinor: number;
	quantity: number;
}

/** Cart total in minor units. Rejects non-integer or negative prices and quantities. */
export function cartTotalMinor(items: CartItem[]): number {
	let total = 0;
	for (const { priceMinor, quantity } of items) {
		if (!Number.isInteger(priceMinor) || priceMinor < 0) throw new RangeError(`invalid price: ${priceMinor}`);
		if (!Number.isInteger(quantity) || quantity < 0) throw new RangeError(`invalid quantity: ${quantity}`);
		total += priceMinor * quantity;
	}
	return total;
}
