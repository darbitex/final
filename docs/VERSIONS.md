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
