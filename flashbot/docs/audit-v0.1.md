# darbitex-flashbot v0.1 — self-audit

Auditor: in-session Claude, 2026-04-15.
Package: `DarbitexFlashbot` at `flashbot/`.
Target: `darbitex_flashbot::flashbot::run_arb` entry function + 2
interface-stub dep packages (`AaveStub`, `ThalaStub`).

---

## 1. ABI verification against live on-chain state

All imported functions were cross-checked against their actual
on-chain ABI via
`GET /v1/accounts/<addr>/module/<name>` REST calls, not against
vendored sources or prior memory.

| Call | On-chain signature | Stub / usage | Match |
|---|---|---|---|
| `aave_pool::flashloan_logic::flash_loan_simple` | `(&signer, address, address, u256, u16) → SimpleFlashLoansReceipt` | AaveStub v2 (fixed from `FlashLoanReceipt` during audit) | ✅ |
| `aave_pool::flashloan_logic::pay_flash_loan_simple` | `(&signer, SimpleFlashLoansReceipt) → ()` | AaveStub | ✅ |
| `thala_adapter::adapter::swap` | `(&signer, Object<thalaswap_v2::pool::Pool>, FungibleAsset, Object<Metadata>, u64) → FungibleAsset` | ThalaStub | ✅ |
| `darbitex::pool::swap` | `(address, address, FungibleAsset, u64) → FungibleAsset` | direct DarbitexFinal dep | ✅ |

**Struct-handle safety:** Both `Object<thalaswap_v2::pool::Pool>` and
`SimpleFlashLoansReceipt` flow through the flashbot as opaque handles
— we never read fields on either. The stub layouts (single
`_dummy: u64` placeholder) are fine because Aptos Move dispatches on
fully-qualified type names, and the real on-chain types are used at
runtime for the actual struct contents.

---

## 2. Arg order, count, types

Traced every call site in `run_arb` against the on-chain ABIs above.
All arg counts match, all types match, all orderings match. No
silent coercions.

---

## 3. Math paths

### Profit calculation

```move
let gross_out = fungible_asset::amount(&fa_result);
assert!(gross_out >= borrow_amount, E_CANT_REPAY);
let profit_total = gross_out - borrow_amount;  // u64, safe
```

Split guarded against underflow by the `E_CANT_REPAY` assertion.
The previous form `gross_out >= borrow_amount + min_net_profit`
could have overflowed u64 on absurd `borrow_amount + min_net_profit`
inputs — **fixed during audit**.

### Treasury share math

```move
let treasury_share = (((profit_total as u128) * (TREASURY_BPS as u128)
    / (BPS_DENOM as u128)) as u64);
let caller_share = profit_total - treasury_share;
```

- u128 widening for the `profit_total × TREASURY_BPS` intermediate
  (max 1.8e19 × 1_000 = 1.8e22, well within u128 max 3.4e38).
- `treasury_share` cast back to u64 is safe because it's strictly
  ≤ `profit_total` which is already u64.
- `caller_share = profit_total − treasury_share` is safe because
  `treasury_share ≤ profit_total`.
- `BPS_DENOM = 10_000` constant, no divide-by-zero.

### Boundary: `min_net_profit` semantics

`min_net_profit` is the floor on the **caller's take-home share**
(post-10%-cut), NOT the gross arb profit. Fixed during audit. The
assertion `caller_share >= min_net_profit` matches user intuition
("I want at least X in my wallet after the arb").

Example: if the caller wants net 100 X, the arb must clear
`gross profit ≥ ⌈100 / 0.9⌉ = 112 X`.

---

## 4. Reentrancy / cross-call side effects

Flash window = between `flash_loan_simple` and `pay_flash_loan_simple`.

Calls during the window:
- `primary_fungible_store::withdraw` — framework, no external callouts
- `pool::swap` — Final primitive, no callouts to Aave, Thala, or flashbot
- `thala::swap` → `thalaswap_v2::pool::swap_exact_in_*` — Thala primitives, no callouts

**None of the downstream calls can reenter Aave, the flashbot, or
the Darbitex core module.** The flash window is contained.

**Caveat for custom FAs:** If a caller supplies a FungibleAsset type
that has transfer hooks (dispatchable FA framework), the hook runs
during `withdraw` / `deposit` and could execute arbitrary code. For
the whitelisted tokens (APT, USDC, USDt, lzUSDC, lzUSDT) this is not
an issue. For custom FAs, the caller accepts the risk when they
supply the address — documented in the module doc comment.

---

## 5. Edge cases

| Case | Behavior | Status |
|---|---|---|
| `borrow_amount = 0` | `E_ZERO_AMOUNT` up-front | ✅ |
| `deadline` in the past | `E_DEADLINE` up-front | ✅ |
| `borrow_asset == other_asset` | First `pool::swap` call aborts (same-token swap unsupported) | ✅ |
| `gross_out < borrow_amount` | `E_CANT_REPAY` | ✅ |
| `gross_out == borrow_amount` | `profit_total = 0`, `caller_share = 0`, fails `E_INSUFFICIENT_PROFIT` if `min_net_profit > 0`, passes cleanly otherwise (no-op repay, wasted gas) | ✅ |
| `profit_total × TREASURY_BPS / BPS_DENOM == 0` (rounds down) | Guard `if (treasury_share > 0)` skips the zero-extract + zero-deposit path | ✅ fixed during audit |
| `caller_share < min_net_profit` | `E_INSUFFICIENT_PROFIT`, full revert | ✅ |
| Custom FA without primary store support | `primary_fungible_store::deposit` aborts, full revert, no funds lost | ✅ |

---

## 6. Interaction with existing Darbitex modules

**Treasury double-taxation check:** Flashbot calls `pool::swap` directly
(low-level primitive), NOT `arbitrage::swap_entry` (which has Final's
own 10% surplus rule). Routing through arbitrage would double-tax
the trade. ✅ Correct bypass.

**LP fee still applies:** `pool::swap` charges the 1 bps LP fee, which
accrues to LPs via pool's internal accumulator. That's the pool's
fee for using its liquidity, independent of flashbot's treasury share.
Not a double-dip.

**Treasury constant consistency:** `TREASURY = 0xdbce8911...` in
flashbot matches `arbitrage::TREASURY` in Final's core. `TREASURY_BPS
= 1_000` (10%) matches `arbitrage::TREASURY_BPS`. Uniform policy.

**No core upgrade:** Flashbot is a pure satellite; Final's core
package is untouched. Matches `feedback_no_core_upgrade.md`.

---

## 7. Error code enumeration

| Code | Name | Meaning | Off-chain mapping |
|---|---|---|---|
| 1 | E_DEADLINE | Deadline passed before execution | "too late, retry with fresh deadline" |
| 2 | E_ZERO_AMOUNT | `borrow_amount == 0` | "caller bug, don't retry" |
| 3 | E_CANT_REPAY | Round-trip output < flash principal | "arb went net-negative, skip" |
| 4 | E_INSUFFICIENT_PROFIT | `caller_share < min_net_profit` | "profitable but below threshold, consider relaxing min or increasing size" |

Distinct codes per failure mode — indexers can categorize attempts.

---

## 8. Event completeness

`FlashArbExecuted` fields:
- `caller` — who triggered
- `thala_first` — direction flag
- `borrow_asset`, `other_asset` — both sides of the cycle
- `darbitex_swap_pool`, `thala_swap_pool` — execution venues
- `borrowed` — flash principal
- `gross_out` — round-trip output
- `profit_total` — gross profit before split
- `caller_share` — 90% slice
- `treasury_share` — 10% slice
- `timestamp`

Enough for off-chain tracking of route profitability, keeper stats,
treasury revenue, and caller leaderboards.

---

## Findings + resolution

| # | Severity | Item | Resolution |
|---|---|---|---|
| 1 | 🔴 BLOCKER | Aave stub struct named `FlashLoanReceipt`; real on-chain type is `SimpleFlashLoansReceipt`. Would abort at runtime. | Fixed in `AaveStub/sources/flashloan_logic.move`. |
| 2 | 🟡 MAJOR | `borrow_amount + min_net_profit` addition could overflow u64. | Rewrote split as two separate checks: `E_CANT_REPAY` first, then `E_INSUFFICIENT_PROFIT` on caller_share. |
| 3 | 🟡 MAJOR | `min_net_profit` ambiguous — applied to gross, not caller's net. | Semantics locked: `min_net_profit` is the caller's post-split floor. Assertion moved after split computation. Documented in module doc comment. |
| 4 | 🟡 MAJOR | `fungible_asset::extract(0)` + zero-amount deposit could abort on some FA backends. | Guarded with `if (treasury_share > 0)`. |
| 5 | 🟡 MAJOR | Single `E_UNPROFITABLE` code hid two distinct failure modes. | Split into `E_CANT_REPAY` + `E_INSUFFICIENT_PROFIT`. |
| 6 | 🟢 MINOR | Custom FAs with transfer hooks could introduce reentrancy during the flash window. | Documented in module doc as a caller-accepted risk. Whitelisted FAs are safe. |
| 7 | 🟢 MINOR | Treasury deposit fails on custom FAs without primary-store support. | Fails cleanly (full revert), no funds lost. No fix needed. |

**Verdict after fixes: 🟢 GREEN. Ready for publish.** Compile clean,
all BLOCKER + MAJOR items resolved, MINOR items are accepted risks
with documentation. No further changes required before proposing the
publish transaction from the publisher wallet.
