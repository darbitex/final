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

## v0.3.0 — 5 bps fee + composability views + WARNING disclosure (2026-04-30)

- **Commit:** TBD (tag `v0.3.0`)
- **Propose tx:** `0x8bb3a41efc2a0c4cfb09885f2c9c47e836a4635616a485e61b966a94103b6384` (multisig seq 7, proposer 0x0047a3e1, 0.018 APT)
- **Execute tx:** `0x9d1f8c32d5cbba5a370618c994a84d0d4719af2b0688c4ada94504f1cd042404` (executor 0x0047a3e1, 0.0029 APT, `is_upgrade: True`)
- **Summary:** Three-item bundle, all ABI-compatible additive changes. (1) Swap + flash fee bumped from 1 bps to 5 bps (100% LP, no protocol cut on swap). (2) Four pre-seal-mandatory composability views added so future satellites (yield aggregator, LP escrow, locker v2, staking v2, marketplace) can compose without further core upgrades. (3) On-chain user-facing risk disclosure (`WARNING` constant + `read_warning()` view), pattern ported from Darbitex Sui — adapted for Aptos: MEV item dropped (Aptos has no public mempool), SLIPPAGE-AND-THIN-LIQUIDITY item added, NO-TREASURY swapped to TREASURY-CUT, SEAL-AT-DEPLOY swapped to UPGRADE-STATUS-COMPATIBLE.
- **Changes:**
  - `pool.move:27-28` — `SWAP_FEE_BPS` and `FLASH_FEE_BPS` both `1 → 5`
  - `pool.move` doc + `arbitrage.move` doc strings updated `1 bps → 5 bps` (3 sites)
  - `pool.move` new const — `WARNING: vector<u8>` (12 numbered disclosure items, ASCII-only)
  - `pool.move` new views — `lp_fee_per_share(pool_addr): (u128, u128)`, `position_pool_addr(pos): address`, `position_fee_debt(pos): (u128, u128)`, `position_pending_fees(pos): (u64, u64)`, `read_warning(): vector<u8>`
  - `tests.move:484` — flash-fee assertion updated `== 10 → == 50` for the 5 bps math
- **Bytecode size:** 37,621 → 43,794 bytes (+6,173, ~16% from WARNING string).
- **Sources:** A1 mirrors Supra port v0.2.0 live + 6/6 LLM R1 GREEN (`darbitex-supra` pkg `0x7599baa7…`). B1 mirrors Sui port pre-seal pattern (`darbitex-sui` pkg `0xf4c6b925…`) and Supra port `pool.move:823-873`. WARNING ports the `darbitex-sui::pool::WARNING` pattern with Aptos-specific item swaps.
- **Stakeholder notification post-execute:**
  - TWAMM keeper `0x9df06f93…` — fee delta affects `bridge::omni_swap_thala_twamm` cycle math; recalibrate keeper bps thresholds
  - Arb keeper bots — may abort with `E_MIN_OUT` until per-leg cost model recomputed
  - Hyperion / Thala / Cellana adapters, aggregator, LP locker, LP staking — pass-through, no change required
  - Frontend `darbitex.wal.app` — quotes are read live from chain, no change required
- **Regression:** all 25 existing unit tests must pass post-edit. New views are read-only (no test failure path), but a `position_pending_fees` smoke test is recommended post-publish.

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

## v0.2.0 — Oracle refresh ergonomics (2026-04-20, same day)

- **Propose tx:** version `4943564364`, hash `0x...` at seq 9 of multisig
- **Execute tx:** version `4943607836`, hash `0x63c68437ca0bd683169e0f1a14e388390c819c751a27d789a0061de3a3300502`
- **Changes:**
  - Auto-refresh stale oracle inside `execute_virtual_order` — reads `darbitex_arb_pool` reserves (same pool used for MEV calc) when oracle age > 300s. Keeper whitelist gates trigger.
  - `MIN_SWAP_FOR_EMA` threshold removed — small-chunk TWAMM now blends oracle via every successful tick. `ratio_ok` 5× + 10% smoothing + keeper whitelist remain as manipulation bounds.
  - New events: `OrderCreated`, `OracleRefreshed`
  - `cancel_order` idempotent guard (`remaining > 0`)
  - `E_ORDER_EXPIRED` renamed `E_TIME_NOT_ADVANCED` (value 2 preserved)
  - `E_STALE_ORACLE` (value 5) removed — unreachable after auto-refresh
- **Design iteration note:** earlier draft exposed `refresh_oracle_from_pool` as permissionless standalone entry. User flagged wrong-pair-pool DDoS vector (attacker refresh every 5 min @ 0.005 APT = ~1.4 APT/day grief). Revised to fold refresh into `execute_virtual_order` where keeper whitelist is the trust gate and pool comes from the keeper's own execute call. No new attacker surface.
- **Audit:** self-audit by Claude Opus 4.7 (GREEN). External audit round skipped for this scope (~30 lines, additive + bounded, storage unchanged). Policy revisit if larger features bundled.
- **PoC smoke (same session):**
  - Order: 5,000 octas APT, 300s duration
  - Tick #1 (version `4943641238`): 1,700 octas APT → 15 USDC units, `OracleRefreshed` fired (oracle had been stale 97 min). Gas 6,037 units.
  - Tick #2 (version `4943689299`): 3,300 octas APT → 30 USDC units, oracle fresh from tick #1 blend — no refresh. Gas 482 units.
  - Full order completed (remaining = 0). Small-chunk TWAMM verified viable.

## v0.3.0 — DEX leg to Darbitex (2026-04-20, same day)

- **Execute tx:** version `4944202224`
- **Changes (`bridge.move`):** single-line functional flip at `:89`:
  ```diff
  - let fa_out = thala::swap(order_signer, thala_pool_obj, fa_in, token_out, min_amount_out);
  + let fa_out = pool::swap(darbitex_arb_pool, order_addr, fa_in, min_amount_out);
  ```
- **Why:** v0.2.0 smoke revealed arb_executed=false on every tick. Root cause: TWAMM DEX leg ran on Thala (external), so Darbitex pool never moved from our TWAMM → oracle tautologically = pool → MEV trigger condition never met. Design intent per owner: oracle = INTERNAL (Darbitex), arb target = EXTERNAL (Thala). v0.3.0 flips DEX leg to Darbitex so user trades actually calibrate our oracle, generate LP fee, and enable MEV divergence windows.
- **Revenue streams unlocked:** (1) AMM LP fee from TWAMM chunks, (2) MEV arb against external venues, (3) oracle-as-a-service validated by real trading activity.
- **Smoke verified (same session):**
  - Darbitex pool pre-trade: 361,851,826 APT + 3,549,724 USDC
  - Tick (version `4944236830`): 1,933 octas APT → 18 USDC units via Darbitex pool::swap. Gas 5,917 units. Event `OracleRefreshed` fired (auto-refresh from stale).
  - Darbitex pool post-trade: 361,853,759 APT + 3,549,706 USDC (+1,933 / -18 — matches chunk)
  - Oracle post-blend: 361,852,019 / 3,549,722 (= 0.9 × old + 0.1 × pool, math verified)
- **Known limitation (V0.4 target):** `calculate_optimal_borrow` formula is asymmetric — MEV only triggers when P_darb > P_oracle (user USDC→APT direction). User APT→USDC trades (drop P_darb) don't trigger arb. Symmetric arb handling = v0.4 candidate.
- **Audit:** self-audit only. Single-line functional change + comments. Additive revenue unlock. Storage unchanged. External audit deferred to V0.4 (symmetric arb) bundle.

## v0.5.0 — Thala-direct arb (first successful MEV execution)

- **Execute tx:** version `4945051700` (upgrade executed 2026-04-20, seq 12)
- **Changes:**
  - `bridge.move::calculate_optimal_borrow` rewritten — compares Darbitex (post-DEX) directly against Thala pool reserves. No oracle dependency for MEV direction.
  - Classic 2-AMM constant-product optimal arb formula: `Δy* = (√(k_D × k_T) − boundary) / (dx + tx)`. Auto-switch Case A (P_darb > P_thala, Thala→Darbitex) or Case B (P_darb < P_thala, Darbitex→Thala).
  - New constant `MIN_ARB_AMOUNT = 1000` USDC units = $0.001 economic floor. Skip MEV if computed borrow below this.
  - Pair-match guard — Thala pool must contain order's `token_in`.
  - u256-space cap before u64 cast (hardening, no silent truncation for large pools).
  - `omni_swap_thala_twamm` signature cleaned — oracle params removed.
  - `ThalaSwapV2` stub extended with `pool_balances` + `pool_assets_metadata` view declarations.
- **Oracle behavior simplified (`executor::execute_virtual_order`):**
  - Removed v0.2.0 auto-refresh-when-stale block
  - Removed v0.4.0 `ratio_ok` 5× gate + 10% EMA blend
  - **Added unconditional overwrite** — every successful tick SETs oracle to post-trade Darbitex pool reserves
  - `MAX_ORACLE_AGE` + `MAX_EMA_DEVIATION` constants removed (unused)
  - Oracle now pure "last Darbitex state via TWAMM", suitable as realtime oracle-as-service feed
- **Design principle locked:**
  - Oracle = INTERNAL (Darbitex) — monetizable as oracle feed
  - Arb target = EXTERNAL (Thala) — direct reference for MEV direction/sizing
  - TWAMM DEX leg on Darbitex captures fee + calibrates oracle
- **Smoke tick 1 (version `4945074942`):** Darbitex pre-trade 0.0098 USDC/APT, Thala 0.00942. Case A triggered. Flash 67,563 USDC via Aave. Profit **1,376 USDC units** (beneficiary 1,239 + treasury 137). Post-arb oracle moved to (369,078,420 / 3,480,222) = 0.00943, arb closed 95% of gap.
- **Smoke tick 2 (version `4945111463`):** tick fired past `end_time` (35s over) — took remaining 3,617 octas. Near-equilibrium state. Case A still triggered with tiny optimal; gross_out = auto_borrow exactly → break-even (profit=0, no revert). Oracle finalized (369,227,325 / 3,478,819) = 0.00943 ≈ Thala 0.00942. **Robustness signal**: even at $7 Darbitex TVL, formula didn't revert on slippage.
- **Audit:** self-audit GREEN, 1 hardening fix applied (u256-space cap). External audit skipped — scope contained to well-understood arb formula + single-venue extension.
- **V0.6 target noted:** tighten buffer 98% → 99% (Candidate L in memory).
