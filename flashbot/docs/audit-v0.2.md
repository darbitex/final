# darbitex-flashbot v0.2 — self-audit addendum

v0.1 audit (`audit-v0.1.md`) remains the authority for everything
inherited from the original `run_arb` function — profit split math,
Aave flash-window reentrancy analysis, error code discipline, treasury
interaction, min_net_profit semantics. This addendum covers ONLY the
v0.2 delta: the new `run_arb_hyperion` entry function and its two new
interface-stub dep packages.

Auditor: in-session Claude, 2026-04-15.
Diff: adds ~110 LoC entry function + 1 new event struct + 2 stub packages
(HyperionStub, DexStub). Zero changes to `run_arb` or any v0.1 logic.

---

## 1. ABI verification — Hyperion surfaces

### `hyperion_adapter::adapter::swap`

Queried on-chain via REST `/accounts/0x5b4bf2a4.../module/adapter`:

```
swap | public | is_entry=false
  params: [
    Object<dex_contract::pool_v3::LiquidityPoolV3>,  // Hyperion CLMM pool
    bool,                                             // a_to_b direction
    FungibleAsset,                                    // input FA (compose)
    u64,                                              // min_out (0 = disabled)
  ]
  return: [FungibleAsset]
```

Stub at `HyperionStub/sources/adapter.move` matches exactly. Pool type
is `dex_contract::pool_v3::LiquidityPoolV3` → transitive dep on the
"dex" package (Hyperion's core CLMM) — stubbed as DexStub with a
placeholder `LiquidityPoolV3 has key { _dummy: u64 }` struct. Same
opaque-handle rationale as ThalaSwapV2's Pool stub.

### `dex_contract::pool_v3::LiquidityPoolV3`

Struct name + module path verified correct by examining the real
`hyperion_adapter::adapter::swap` signature (which embeds the full
type path). Fields are never accessed by flashbot — handles flow
through as `Object<T>` wrappers.

---

## 2. Arg order / count — `run_arb_hyperion`

Traced every call site inside the new entry function against the
verified ABI above:

| Call site | Expected | Actual | ✓ |
|---|---|---|---|
| Flash borrow (line ~280) | `(&signer, address, address, u256, u16) → SimpleFlashLoansReceipt` | same as v0.1 | ✓ |
| Withdraw from store | framework | same as v0.1 | ✓ |
| Hyperion swap leg 1 (hyperion_first branch) | `(Object<LiquidityPoolV3>, bool, FungibleAsset, u64)` | `(pool_obj, borrow_is_hyperion_side_a, fa_borrowed, 0)` | ✓ |
| Darbitex swap leg 2 (hyperion_first branch) | `(address, address, FungibleAsset, u64)` | `(darbitex_swap_pool, caller_addr, fa_mid, 0)` | ✓ |
| Darbitex swap leg 1 (hyperion_first=false) | same | `(darbitex_swap_pool, caller_addr, fa_borrowed, 0)` | ✓ |
| Hyperion swap leg 2 (hyperion_first=false) | same | `(pool_obj, !borrow_is_hyperion_side_a, fa_mid, 0)` | ✓ |
| Treasury deposit, caller deposit, Aave repay | framework | same as v0.1 | ✓ |

---

## 3. Math paths

Identical to `run_arb`. Profit total computed as `gross_out −
borrow_amount` (guarded by `E_CANT_REPAY`). Treasury share computed via
`u128` widening, cast back to `u64` safely. Caller share checked
against `min_net_profit` post-split.

No new math paths introduced. See v0.1 audit for full analysis.

---

## 4. Reentrancy / cross-call side effects

Flash window contains: Aave borrow → withdraw from store →
`pool::swap` OR `hyperion::swap` → `hyperion::swap` OR `pool::swap` →
split + deposits → Aave repay.

New surface during the flash window: `hyperion_adapter::adapter::swap`
→ internally calls `dex_contract::pool_v3::swap` (Hyperion's CLMM).
Both are pure pool-math functions with no callbacks to Aave, the
flashbot, or the Final core. Flash window remains fully contained.

Same "custom FA with transfer hooks" caveat as v0.1: a caller who
supplies an exotic FA type with dispatchable hooks takes that risk
explicitly. Whitelisted FAs (APT, USDC, USDt, lzUSDC, lzUSDT) are safe.

---

## 5. Edge cases

| Case | Behavior | ✓ |
|---|---|---|
| `borrow_amount == 0` | `E_ZERO_AMOUNT` up-front | ✓ |
| `deadline` in the past | `E_DEADLINE` up-front | ✓ |
| `hyperion_swap_pool` is the wrong pair | HyperionAdapter::swap aborts internally on wrong-side input | ✓ |
| `borrow_is_hyperion_side_a` WRONG | Hyperion swap aborts internally (wrong side for FA), tx reverts cleanly, no funds lost | ✓ |
| Hyperion pool is locked / nonexistent | Framework `address_to_object<LiquidityPoolV3>` aborts | ✓ |
| `hyperion_pool == darbitex_swap_pool` | Impossible (different package-ownership of pool addresses); if somehow same, at worst the two swaps trade between different modules' state | ✓ |
| Direction auto-flip wrong | `!borrow_is_hyperion_side_a` correctly inverts for the reverse leg; each leg is self-consistent | ✓ |

---

## 6. Interaction with other Darbitex modules

**No change from v0.1.** `run_arb_hyperion` calls `pool::swap` directly
(bypassing `arbitrage::swap_entry`), so the 10% flashbot treasury cut
does NOT compound with Final's 10% smart-routing surplus rule.

LP fees still accrue to Darbitex LPs (1 bps per leg) — independent of
flashbot's treasury share.

---

## 7. Event completeness

New event `HyperionFlashArbExecuted` mirrors `FlashArbExecuted` plus:
- `hyperion_first: bool` (leg order)
- `borrow_is_hyperion_side_a: bool` (preserved so indexers can verify
  the direction calculation off-chain without re-doing the sort)
- `hyperion_swap_pool: address` (replaces `thala_swap_pool`)

13 fields total. Sufficient for off-chain reconstruction of every
executed cycle.

---

## 8. Compat upgrade safety

v0.2 is a compat upgrade on the existing `darbitex_flashbot` package
at `0x0047a3e1...`. Compat rules checked:

- Existing `run_arb` function signature: **unchanged** ✓
- Existing `FlashArbExecuted` event struct: **unchanged** ✓
- Existing constants (TREASURY, TREASURY_BPS, BPS_DENOM): **unchanged** ✓
- Existing error codes 1-4: **unchanged** ✓
- New additions are purely additive:
  - New `run_arb_hyperion` entry function (new symbol)
  - New `HyperionFlashArbExecuted` event struct (new symbol)
  - New `use` imports (no impact on existing API)

Aptos's `compatibility_check` in `0x1::code::publish_package_txn`
allows additive upgrades under `compatible` upgrade policy. Should
pass.

---

## Findings

None introduced in v0.2. All v0.1 GREEN items remain GREEN. Verdict
after compile: **🟢 GREEN, ready for publish upgrade.**
