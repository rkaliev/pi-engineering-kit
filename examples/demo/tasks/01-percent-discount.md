# Percent discount on the cart total

Checkout needs to apply a whole-number percent discount to a cart total.

## Criteria
1. `applyPercentDiscount(totalMinor, percent)` returns the total minus the discount, in integer minor units.
2. The discount amount is rounded half-up to a whole minor unit: 10% of 1999 → discount 200 → result 1799; 15% of 1010 → discount 152 → result 858.
3. 0% returns the total unchanged; 100% returns 0.
4. A percent that is not an integer from 0 to 100 throws `RangeError`.
5. A total that is not a non-negative integer throws `RangeError`.

## Constraints
- Logic in `src/discount.ts` as a pure function, tests in `src/discount.test.ts` for criteria 1–5.
- Integer arithmetic only: no floating-point intermediate results that could round wrongly.
- Don't change `src/cart.ts`.

## Out of scope
- Fixed-amount discounts, multiple discounts, currencies with other exponents.
