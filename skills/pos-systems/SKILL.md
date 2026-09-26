---
name: pos-systems
description: Use when building or changing point-of-sale, checkout, cash register, kiosk or terminal software - receipts, shifts, fiscal devices, card terminals, printers, scanners or offline sales
---

# POS systems

A POS must keep selling when the network, the server or a device fails, and every sale must end up correct in the books and with the tax authority. Load payments-and-money too. It governs amounts, idempotency and card data.

## Offline-first

- **The local store is the source of truth at the till.** Sales, receipts and shift state are written durably on the device first (SQLite/Room/Core Data, with WAL and transactions), then synced.
- **Sync queue:**
  - operations get client-generated UUIDs and are idempotent on the server;
  - retry with backoff;
  - the server keeps an ordering per device;
  - conflicts resolve by explicit rules (catalog: server wins; sales: append-only, never overwritten).
- **Time:** the device clock drifts. Store both the device time and the server receive time. Never trust device time for security decisions.
- **Catalog and prices** are cached with a version. The receipt snapshots the price, tax and discount that applied at sale time.
- Test by killing the process mid-sale, cutting the network mid-payment, filling the disk, and restoring from backup.

## Fiscalization and receipts

- **Receipts are immutable.** Mistakes are fixed with a refund or correction receipt, never by editing. Fiscal documents are numbered sequentially without gaps.
- The fiscal rules depend on the jurisdiction. **Identify it and ask.** In Russia, 54-ФЗ applies:
  - an online cash register (ККТ) with a fiscal drive (ФН);
  - transmission through an ОФД;
  - the fiscal document format version (ФФД) the device supports;
  - required receipt fields (tax system, VAT rate per line, payment method and sign, cashier);
  - product marking codes (Честный ЗНАК) for marked goods.
  Other countries have their own schemes (for example TSE in Germany, RKSV in Austria).
- Use the fiscal device vendor's official driver or SDK. Model the device's own state machine: shift open/closed, document open, paper out, fiscal drive full or expiring. Surface every device error to the cashier with a clear action.
- **Shifts:** open shift → sales → X-report (non-closing) → Z-report (close). Cash-in/cash-out operations are recorded. Warn before a shift exceeds its legal maximum length.
- Tax rates and rules change by law. Keep them in effective-dated configuration and test the switch-over.

## Card terminals and peripherals

- Integrate card terminals through the acquirer or vendor SDK or protocol.
  - The POS never sees the PAN. It gets a result code, a masked PAN, an RRN or auth code, and the slip text.
  - **An unknown result (timeout, cable pulled) is resolved by asking the terminal for its last-transaction status or reconciling**, never by charging again.
  - Store the terminal's slip and the transaction ids with the sale.
  - The daily terminal settlement (сверка итогов) happens at or before shift close.
- **Receipt printers:** ESC/POS or the vendor SDK. Handle paper-out and cover-open; allow reprints marked as copies.
- **Barcode scanners:** usually HID keyboard input. Detect scanner bursts (timing and a suffix character) so scans don't land in the wrong field. Validate EAN/UPC check digits.
- **Scales, cash drawers, customer displays:** abstract each behind a small interface with a fake implementation for tests and demos.

## UX and operations

- Large touch targets, few steps per sale, keyboard or scanner-only flows, and visible offline and device status.
- Role-based permissions (cashier / senior / admin) for voids, discounts, refunds and opening the drawer without a sale. Log every override with who approved it.
- Remote logs and health: queue length, last sync, device errors, fiscal drive expiry date.
- Updates must not interrupt an open shift. Stage them and apply between shifts.

## Testing

Automate against fakes of every device plus the vendor's emulator where one exists. Keep a manual checklist for real hardware:
- sale, refund, correction receipt;
- shift open and close;
- paper out mid-receipt;
- network loss mid-payment;
- terminal timeout.
State explicitly which of these ran on real hardware.
