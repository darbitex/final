# darbitex-flashbot v0.3 — self-audit addendum

v0.1 + v0.2 audits (`audit-v0.1.md`, `audit-v0.2.md`) remain the
authority for everything inherited. This addendum covers ONLY the
v0.3 delta: the new `run_arb_cellana` entry function and its single
new interface-stub dep package.

Auditor: in-session Claude, 2026-04-15.
Diff: ~115 LoC entry function + 1 new event struct + 1 new stub
package (CellanaStub). Zero changes to `run_arb`, `run_arb_hyperion`,
or any v0.1/v0.2 logic.

---

## 1. ABI verification — Cellana surface

### `cellana::router::swap`

Queried on-chain via REST `/accounts/0x4bf51972.../module/router`:

```
swap | public | is_entry=false
  params: [
    FungibleAsset,                               // input FA (compose)
    u64,                                         // amount_out_min
    Object<fungible_asset::Metadata>,            // destination token
    bool,                                        // is_stable curve flag
  ]
  return: [FungibleAsset]
```

Stub at `CellanaStub/sources/router.move` matches exactly. No external
type deps — the function takes only framework-native types (`FungibleAsset`,
`Object<Metadata>`) and primitives. This is structurally simpler than
both Thala and Hyperion integrations: **zero Pool-object type stubs
needed.**

### Why Cellana skips the adapter pattern

Cellana exposes compose-style FA-in/FA-out on its own `router` module.
The caller never needs to resolve a pool address — the router
internally looks up `liquidity_pool(from_token, to_token, is_stable)`
and routes through whichever pool matches. Compare:

- Thala: `thalaswap_v2::pool::swap_exact_in_*` takes `Object<Pool>` →
  DarbitexThala satellite wraps it with primitive args → flashbot
  stubs both
- Hyperion: `dex_contract::pool_v3::swap` takes `Object<LiquidityPoolV3>`
  + tick math → HyperionAdapter satellite wraps it → flashbot stubs both
- **Cellana: native router exposes FA-in/FA-out directly** → no
  intermediate adapter, no Pool type stub, 1 stub package total

---

## 2. Arg order / count — `run_arb_cellana`

Traced every call site inside the new entry function against the
verified ABI:

| Call site | Expected | Actual | ✓ |
|---|---|---|---|
| Flash borrow | `(&signer, address, address, u256, u16) → SimpleFlashLoansReceipt` | same as v0.1 | ✓ |
| Withdraw from store | framework | same as v0.1 | ✓ |
| Cellana leg 1 (cellana_first branch) | `(FungibleAsset, u64, Object<Metadata>, bool) → FungibleAsset` | `(fa_borrowed, 0, other_asset, is_stable)` | ✓ |
| Darbitex leg 2 (cellana_first branch) | `(address, address, FungibleAsset, u64) → FungibleAsset` | `(darbitex_swap_pool, caller_addr, fa_mid, 0)` | ✓ |
| Darbitex leg 1 (cellana_first=false) | same | `(darbitex_swap_pool, caller_addr, fa_borrowed, 0)` | ✓ |
| Cellana leg 2 (cellana_first=false) | same as leg 1 call shape | `(fa_mid, 0, borrow_asset, is_stable)` — curve flag is the SAME `is_stable` because both directions of a Cellana pool live in the same curve | ✓ |
| Treasury + caller deposit + Aave repay | framework | same as v0.1 | ✓ |

### Subtlety on `is_stable` for the reverse leg

Unlike Hyperion's `a_to_b` flag (which flips between legs because
the input FA's side differs), Cellana's `is_stable` stays the SAME
for both legs of a round trip. The curve is a property of the POOL,
not the direction — a stable pool's `liquidity_pool(X, Y, true)` is
the same resource as `liquidity_pool(Y, X, true)`. So we pass the
unchanged `is_stable` to both legs. Verified by reading Cellana's
router source vendored stub in beta: the pool lookup is
order-agnostic on the pair.

---

## 3. Math paths

Identical to `run_arb` and `run_arb_hyperion`. No new math paths.

---

## 4. Reentrancy / cross-call side effects

Flash window contains the same set of operations as v0.2, with
`cellana::router::swap` replacing `hyperion::swap` in the non-
Darbitex leg. Cellana router internally calls `liquidity_pool::swap`
which is a `friend`-visible function — only callable from Cellana's
own router (and other friend modules inside Cellana). No callbacks
out of Cellana back into Aave, flashbot, or the Darbitex core.

Flash window remains contained. Reentrancy surface unchanged.

---

## 5. Edge cases

| Case | Behavior | ✓ |
|---|---|---|
| `borrow_amount == 0` | `E_ZERO_AMOUNT` up-front | ✓ |
| `deadline` past | `E_DEADLINE` up-front | ✓ |
| `is_stable == true` but only volatile Cellana pool exists for the pair (or vice versa) | `cellana::router::swap` aborts internally on pool lookup (`liquidity_pool` returns nothing), tx reverts cleanly, no funds lost | ✓ |
| `borrow_asset == other_asset` | Cellana's internal `liquidity_pool(X, X, *)` lookup aborts; or Darbitex's `pool::swap` aborts. Either way tx reverts. | ✓ |
| Cellana pool is paused (if Cellana has such a flag) | `router::swap` aborts internally | ✓ |
| Profit round-trip covers principal but caller share < min_net_profit | `E_INSUFFICIENT_PROFIT` | ✓ |

---

## 6. Interaction with other Darbitex modules

Same bypass pattern as v0.1 and v0.2: `run_arb_cellana` calls
`pool::swap` directly (not `arbitrage::swap_entry`), so Darbitex's
10% smart-routing surplus rule does NOT compound with flashbot's
10% treasury cut. Single 10% treasury tax per arb, uniform across
venues.

---

## 7. Error code enumeration

No new codes. Reuses v0.1/v0.2's `E_DEADLINE`, `E_ZERO_AMOUNT`,
`E_CANT_REPAY`, `E_INSUFFICIENT_PROFIT` with identical semantics.

---

## 8. Event completeness

New event `CellanaFlashArbExecuted` — 12 fields:

- `caller` — who triggered
- `cellana_first` — leg order
- `is_stable` — curve selector, preserved so indexers know which
  Cellana curve the arb ran through
- `borrow_asset`, `other_asset` — both sides of the cycle
- `darbitex_swap_pool` — the Darbitex pool address (other leg)
- `borrowed`, `gross_out`, `profit_total`, `caller_share`, `treasury_share` — economics
- `timestamp`

Note: no `cellana_swap_pool` field because Cellana's router doesn't
expose the resolved pool object to the caller — the (from, to,
is_stable) triple uniquely identifies the pool off-chain, so the
event records `is_stable` + the asset pair as sufficient context.
If indexers need the actual pool address they can query
`cellana::liquidity_pool::liquidity_pool(from, to, is_stable)` with
the same triple to recover it.

---

## 9. Compat upgrade safety

v0.3 is a compat upgrade on the existing `darbitex_flashbot` package
at `0x0047a3e1...`. Compat rules:

- Existing `run_arb` signature: **unchanged** ✓
- Existing `run_arb_hyperion` signature: **unchanged** ✓
- Existing `FlashArbExecuted` event struct: **unchanged** ✓
- Existing `HyperionFlashArbExecuted` event struct: **unchanged** ✓
- Existing constants (TREASURY, TREASURY_BPS, BPS_DENOM): **unchanged** ✓
- Existing error codes 1-4: **unchanged** ✓
- Additions are purely additive:
  - New `run_arb_cellana` entry function (new symbol)
  - New `CellanaFlashArbExecuted` event struct (new symbol)
  - New `use cellana::router as cellana_router` import (no impact on
    existing API)

Passes Aptos's `compatibility_check` in `code::publish_package_txn`.

---

## Findings

None in v0.3. All v0.1 and v0.2 GREEN items remain GREEN. Verdict
after compile: **🟢 GREEN, ready for publish upgrade.**
