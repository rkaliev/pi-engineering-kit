---
name: payments-and-money
description: Use when code handles money amounts, prices, currencies, payments, refunds, payouts, billing, wallets, ledgers, payment provider webhooks or card data
---

# Payments and money

Payment bugs lose real money, cannot always be undone, and bring regulators. Every payment operation must be **correct, idempotent, auditable and reconcilable**. Prefer boring, proven designs and the provider's official SDK.

## Amounts

- **Never use binary floating point for money.** Use integer minor units (`amountMinor: 1999`) together with the currency, or a decimal type (`BigDecimal`, `decimal`, `Decimal`, `NUMERIC`).
- The currency always travels with the amount. The minor-unit exponent comes from ISO 4217 (JPY 0, USD 2, KWD 3), never an assumed 2.
- Round once, at a defined point, with an explicit mode: half-up, or banker's rounding, as the business, tax or fiscal rule requires. When splitting (instalments, tax lines, split payments), allocate the remainder so the parts sum exactly to the total.
- In JSON and APIs, send amounts as integers in minor units or as decimal strings, never as floats.
- Tax, fee and FX rates are **effective-dated configuration**, not constants. Laws change them.

## Operations

- **Idempotency on every mutating call.** The client generates an idempotency key per business operation. The server stores the key with the result and returns the same result on retry. Pass the key through to the provider.
- **Explicit state machine** per payment, for example `created → authorized → captured → refunded(partial|full)`, plus `failed`, `canceled`, `expired`. Transitions are validated. States are never overwritten backwards.
- **Timeouts mean unknown, not failed.** After a timeout or a dropped connection, query the provider for the status before retrying or telling the user it failed. Never charge twice.
- **Webhooks:**
  - verify the signature against the raw body with a constant-time comparison;
  - reject stale timestamps;
  - dedupe by event id;
  - tolerate out-of-order delivery (re-fetch the object when in doubt);
  - acknowledge fast, process asynchronously.
- **Atomicity:** write the state change and the outgoing message together (outbox pattern), or use a DB transaction. No "charge, then crash before saving".
- **A ledger for balances:** use double-entry, append-only entries, and a balance derived from the entries. Corrections are new entries, never updates or deletes.
- **Reconciliation:** a scheduled job compares internal records with provider settlement reports and flags mismatches. Design for it from day one.
- **An audit trail** for who did what and when (refunds, manual adjustments, config changes). Audit rows are immutable.

## Card data and compliance

- **Minimize PCI DSS scope.** Use hosted fields, redirects or the provider SDK's tokenization, so the raw PAN never touches your servers or logs.
- **Never store the CVV/CVC**, even encrypted. Never log a PAN (mask it to the first 6 and last 4 digits at most), a CVV, a full track, or a PIN. Scrub request logs, error reports and analytics.
- Strong customer authentication (3-D Secure / SCA) where the region requires it, with a fallback for challenge failure or timeout.
- Keys and secrets live in a secret manager, with separate keys per environment and restricted scopes. Test mode and live mode must never mix.

## Testing

- Unit-test the amount math: rounding, allocation, currencies with exponents 0 and 3, negative and zero amounts, large values.
- Test idempotency (the same key twice gives one charge), each state transition (and the invalid ones), webhook replay and out-of-order delivery, and timeout → status query.
- Run integration tests against the provider's **sandbox** with its test cards and scenarios (declines, 3DS challenges, network errors).

## Review points (add to code review)

- Floats near money.
- Missing idempotency key.
- Retry after a timeout without a status check.
- Unverified webhook.
- Card data in logs.
- Balance mutated in place.
- Missing currency.
- Tax rate hard-coded.

**Destructive actions need human confirmation:** real charges, refunds, payouts, live-key operations, migrations on payment tables. See pos-systems for in-store payments and security-review for the broader audit.
