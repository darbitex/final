# R2 Audit Findings — Darbitex Flashbot + TWAMM

> **Date**: 2026-04-20
> **Auditor**: Claude (Opus 4.7)
> **Scope**: `AUDIT-R2-BUNDLE.md` — `flashbot/sources/bridge.move` + `twamm/sources/twamm.move`
> **Bundle vs source**: identical (trivial whitespace only)

Severity-ordered. File/line numbers refer to the source files in `flashbot/sources/bridge.move` and `twamm/sources/twamm.move` (bundle offsets noted where relevant).

---

## CRITICAL

### C-1. `omni_swap_thala_twamm` never calls `unlock_state()` — permanently bricks bridge module

**File**: `flashbot/sources/bridge.move:404-486`

Function is declared `acquires State` and calls `lock_state()` at line 420, but the function body ends at line 485-486 with no `unlock_state()` call. Compare:

- `omni_swap_hyperion_twamm` — `unlock_state()` at line 571 ✅
- `omni_swap_cellana_twamm` — `unlock_state()` at line 655 ✅
- `omni_swap_thala_twamm` — **missing** ❌

**Consequence**: the first TWAMM tick via Thala (which is the *only* path hardcoded at `twamm.move:894` — `bridge::omni_swap_thala_twamm`) leaves `State.is_locked = true` permanently. Every subsequent call to any `omni_swap_*` entry function in bridge aborts with `E_REENTRANT (6)`. **Bridge module permanently bricked**; recovery requires a package upgrade.

**Fix**: append `unlock_state();` before the closing `}` at line 486, matching the pattern used by the other two TWAMM variants (`};\n        unlock_state();\n    }`).

---

### C-2. Deadline=0 in Thala arbitrage legs — R2 changelog item #5 is false

The R2 changelog claims: *"Deadline Propagation: All external DEX swaps now respect the user deadline."* This is not true for Thala arb legs:

- `bridge.move:205` (`omni_swap_thala`): `thala::swap(user, thala_pool_obj, fa_borrowed, token_in, 0)` — deadline=0
- `bridge.move:443` (`omni_swap_thala_twamm`): same, deadline=0

Hyperion arb legs correctly propagate `deadline` (lines 293, 528). Cellana has no deadline parameter.

**Consequence**: depending on Thala's `deadline=0` handling, either (a) the arb leg reverts immediately (denying arb profit), or (b) Thala treats 0 as "no deadline" and the user's deadline intent is silently dropped during the flash window.

**Fix**: replace `0` with `deadline` in both Thala arb-leg swaps.

---

## HIGH

### H-1. Oracle staleness has no recovery path

**File**: `twamm/sources/twamm.move:880, 935, 789, 804`

`oracle.last_timestamp` is only refreshed when the EMA actually updates, which requires BOTH:

1. `amount_to_swap >= MIN_SWAP_FOR_EMA` (1e6 raw units), AND
2. Spot-to-EMA price ratio ≤ 5x

If a sequence of small orders or volatile-price ticks all fail the filter, the oracle goes stale past 300s → every subsequent tick aborts with `E_STALE_ORACLE (5)`. Both init paths (`init_ema_oracle`, `init_ema_from_pool`) are one-shot (`!exists<EmaOracle>` guard at lines 772, 789, 804). There is no admin push, no force-refresh, no fallback.

**Consequence**: once the oracle is stale, all TWAMM orders are frozen and user funds stuck in the order object until a package upgrade adds a refresh path.

**Fix**: add an admin-gated `push_ema(account, reserve_in, reserve_out)` function, or significantly loosen `MAX_ORACLE_AGE` if the expected swap volume is thin.

---

### H-2. 50% slippage window on external leg enables cheap DoS

**File**: `twamm/sources/twamm.move:899`

The executor passes `min_out / 2` as `min_amount_out` to the bridge, allowing the external (Thala) swap to complete at up to 50% slippage. The final check at line 913 (`actual_amount_out >= min_out` on total output) reverts the entire tx on a loss — so **no fund loss** — but:

**Consequence**: a sandwich attacker can trivially force the bridge's external leg to near-min_out/2 output, causing the total-check to revert. Keeper burns gas, order does not progress, attacker keeps sandwich profit. Cheap grief vector; stalls TWAMM progress.

**Fix**: tighten the intermediate floor (e.g., `min_out * 80 / 100`) so that the external leg rejects obvious sandwiches before the flash arb even fires.

---

## MEDIUM

### M-1. Dead TWAMM variants — Hyperion and Cellana unreachable

**File**: `flashbot/sources/bridge.move:489, 575`

`executor.execute_virtual_order` hardcodes `bridge::omni_swap_thala_twamm` at `twamm.move:894`. The Hyperion and Cellana TWAMM variants are never called. Either:

- **Remove** both functions to reduce surface area, or
- **Wire** them via a venue selector (e.g., `venue: u8` parameter in `execute_virtual_order`) with a whitelist.

---

### M-2. `init_ema_oracle` is `public fun`, not `entry`

**File**: `twamm/sources/twamm.move:763`

Declared `public fun` so it's unreachable from a transaction. Only `init_ema_from_pool` (entry) can bootstrap the oracle. This function is either dead code or a test-only helper.

**Fix**: remove, or promote to `entry` if it's meant to be an alternative init path.

---

### M-3. EMA `reserve_in` is frozen forever (misleading comment)

**File**: `twamm/sources/twamm.move:928-932`

```move
let spot_reserve_in = oracle.reserve_in;
let spot_reserve_out = spot_reserve_in * (actual_amount_out as u128) / (amount_to_swap as u128);

oracle.reserve_in = (oracle.reserve_in * 9 + spot_reserve_in) / 10;
oracle.reserve_out = (oracle.reserve_out * 9 + spot_reserve_out) / 10;
```

Since `spot_reserve_in = oracle.reserve_in`, the blend reduces to `(9·x + x)/10 = x`. `reserve_in` is mathematically frozen at the init value. The comment *"blend implied spot reserves to prevent magnitude decay"* is misleading — the actual design is a **frozen-denominator price-ratio EMA**.

This is not a bug (`calculate_optimal_borrow` only uses the ratio), but the design intent should be documented accurately to prevent future contributors from "fixing" it.

**Fix**: update the comment to explicitly state that `reserve_in` is the fixed denominator and only `reserve_out` tracks the implied spot price.

---

### M-4. Keeper signer unverified → grief via bad `darbitex_arb_pool`

**File**: `twamm/sources/twamm.move:844-846`

`_keeper: &signer` is unused — permissionless by design. A malicious keeper can pass any `darbitex_arb_pool`; the swap at line 613/529 will abort when tokens mismatch, but the order's `last_executed_time` has already been bumped at line 874 BEFORE the bridge call.

Wait — re-reading line 874: `order.last_executed_time = now` happens before the bridge call. If the bridge call aborts, the entire tx reverts, so `last_executed_time` is NOT persisted. Safe.

**Reduced severity**: just documenting that keeper can burn their own gas on bad inputs without affecting order state. Not an exploit. Still worth a whitelist for good keeper UX.

---

## LOW

### L-1. Unused import

**File**: `flashbot/sources/bridge.move:8`

`use aptos_std::math128;` — no `math128::` references in the module. Compile warning.

**Fix**: remove the import.

---

### L-2. Aave 0-fee assumption is operational

Code assumes `pay_flash_loan_simple` accepts `auto_borrow_amount` as full repayment. Per prior memory (`feedback_aave_flash_standard`), Aave on Aptos is currently 0-fee. If the Aave governance updates the fee policy, all `omni_swap_*` calls break silently (abort at repay).

**Mitigation**: document this dependency; monitor Aave Aptos governance, or pre-compute `auto_borrow_amount + fee` from `flashloan_logic` view.

---

### L-3. Cosmetic — inconsistent indentation

The `else` branches emit events with a leading space: ` event::emit(OmniSwapExecuted { ...` at lines 241, 328, 412, 478, 563, 647. All other `event::emit` calls are correctly indented.

---

## Structural / Testing Gap

- **No `tests/` directory** in either `flashbot/` or `twamm/`. Compile-green ≠ safe. A single property test on lock/unlock symmetry would have caught finding **C-1** automatically.
- **No integration test** for the full TWAMM → bridge → Thala → Darbitex → Aave repay flow.

**Recommendation**: before mainnet publish, add at minimum:
1. Unit test that calls each `omni_swap_*` twice in sequence — will fail immediately on C-1.
2. Unit test that ticks an order past `MAX_ORACLE_AGE` with sub-MIN_SWAP_FOR_EMA amounts — will expose H-1.
3. Symbolic check that `lock_state()` and `unlock_state()` call counts match per entry function.

---

## Ship Gate Summary

| Finding | Must fix before publish? |
|---------|--------------------------|
| C-1 (missing unlock) | ✅ YES — module brick |
| C-2 (deadline=0 Thala) | ✅ YES — changelog claim |
| H-1 (oracle stale trap) | ⚠️ Strongly recommended |
| H-2 (50% slippage DoS) | ⚠️ Strongly recommended |
| M-1 (dead TWAMM code) | Optional |
| M-2 (`init_ema_oracle` dead) | Optional |
| M-3 (EMA comment) | Optional |
| M-4 (keeper UX) | Optional |
| L-1 to L-3 | Optional |

C-1 alone is a no-ship blocker. The 1-line fix:

```move
// At bridge.move:485, change:
        }
    }
// to:
        };
        unlock_state();
    }
```
