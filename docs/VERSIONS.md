# Darbitex Final — Version History

Package: `0xc988d39a4a27b26e1d659431a0c5828f3862c155d1c331386cd5974298dd78dd`
Multisig: 3/5

---

## v0.1.0 — Initial deploy (2026-04-14)

- **Commit:** tagged retroactively
- **Tx:** initial multisig publish + init_factory
- **Summary:** Core AMM (pool, pool_factory, arbitrage). x*y=k constant product, 1 bps swap/flash fee, 100% LP. R3.1 audit (13 passes, Gemini R3 GREEN).
- **Views:** pool_exists, reserves, pool_tokens + factory views (get_all_pools, canonical_pool_address_of, pools_containing_asset, pools_containing_asset_count)

## v0.2.0 — LP data views (2026-04-16)

- **Commit:** `b25f3bb`
- **Propose tx:** `0x0842e1ca461cdd26ab344df6b7ad4fcf3650561e12b573a6ded578e7948a9a7c`
- **Execute tx:** `0x3a301d195791ecc33622dc2ab361c7a8b33717bc1146fbefc6f1b304c8160947`
- **Summary:** 2 read-only views added to `pool` module. Unblocks LP staking satellite.
- **Changes:**
  - `#[view] public fun lp_supply(pool_addr): u64` — total LP shares in pool
  - `#[view] public fun position_shares(pos: Object<LpPosition>): u64` — shares per position
- **Regression:** 25 unit tests (was 1 sanity stub). Full coverage: pool creation, add/remove liquidity, swap, flash loan, fee accrual, entry wrappers, factory views, new views.
- **Note:** On-chain package metadata still carries `0.1.0` (Move.toml not bumped before compile). Bumped to `0.2.0` locally post-deploy. Next upgrade will carry `0.2.0` on-chain.

---

# TWAMM Satellite — Version History

Package: `0x9df06f93369effe15ab626044bbbcb03e6bf198af909ac4c133719e637771cf4`
Multisig: 3/5 (bootstrapped 1/5 → raised 2026-04-20)

## v0.1.0 — Initial publish (2026-04-20)

- **Execute tx:** version `4942424268`, hash `0x3489031ef9fb73c9de660269a1c3615746c5068ce5fffd162f78d6453e82aff5`
- **Modules:** `bridge` + `executor` (colocated, `public(friend)` intra-package)
- **Audit:** R5.1 bundle — 7 independent AI auditors GREEN (Opus self, Gemini 3 Flash, Kimi K2.5 source-verified, Grok, Qwen, OpenHands, DeepSeek)
- **Summary:** TWAMM virtual-order executor with EMA oracle, keeper whitelist, owner-cancel escape hatch, and MEV bridge (Thala-only). Single-pair per deploy (APT/USDC).
- **Known bug** (fixed in v0.1.1 before first smoke): `bridge::omni_swap_thala_twamm` passed `deadline` as arg 5 to `thala::swap`, which expects `min_out`. Not caught by any static audit — both are `u64`. Mainnet first-tick smoke caught it via `E_MIN_OUT` abort.

## v0.1.1 — thala::swap param fix (2026-04-20, same day)

- **Execute tx:** version `4942656615`
- **Changes (`bridge.move`):**
  - Line 89 (user leg): pass `min_amount_out` (not `deadline`) as arg 5 to `thala::swap`
  - Line 104 (arb leg): pass `0` as arg 5 (economic guard is final `gross_out >= auto_borrow_amount` repay check)
- **Re-smoke:** version `4942678952` — 0.00208 APT → 0.001944 USDC via Thala 5bps pool `0xa928...`, `arb_executed: false` (oracle matches Darbitex pool, no divergence — expected)
- **Lesson:** Smoke test with real tokens is the last line of defense against cross-package ABI mismatches. Ref `memory/feedback_smoke_test.md`.
