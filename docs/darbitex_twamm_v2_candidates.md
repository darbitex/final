---
name: Darbitex TWAMM V2 candidates
description: Two deferred design improvements for TWAMM, to reconsider after V1 mainnet soak. Inspired by Uniswap V4 TWAMM hook research (2026-04-20).
type: project
originSessionId: b723ec02-3298-4fac-9e6b-5a63ad6992b5
---
Deferred from R4 (2026-04-20) to avoid restarting audit clock. Reconsider after V1 TWAMM runs on mainnet for 1-2 weeks with real orders + keeper activity.

## Candidate A: Bounty-based permissionless executor

**Why**: eliminate single-keeper-bot dependency, create MEV market for TWAMM execution timeliness.

**How**: remove `AdminState.keeper_whitelist` check in `execute_virtual_order`. Add bounty transfer: a small slice of swap proceeds → caller. Anyone who finds a profitable TWAMM tick executes it.

**Open design decisions** (must be answered before coding):
- Bounty source: order token_in cut? MEV profit share? protocol-paid from treasury?
- Bounty sizing: flat? % of swap? dynamic (higher for stale orders)?
- Spam floor: minimum swap size to trigger to prevent dust DoS

**Cost**: ~30-50 lines in `twamm.move`, 1 audit round (R5), ~2 days calendar.

**How to apply**: ship as satellite update (compatible upgrade), no core changes.

## Candidate B: Rate-based continuous virtual orders

**Why**: inspired by V4 TWAMM. Two-way simultaneous orders (both A→B and B→A) with closed-form coupled ODE integration. Mathematically elegant, better precision than discrete chunks.

**Blockers**:
- Breaking change to `LongTermOrder` struct → storage incompat → requires fresh package, NOT compat upgrade
- Coupled ODE solver is math-heavy, hard to audit
- Marginal gain for Aptos scale — discrete chunks work fine for expected TVL

**Verdict**: likely not worth it unless observed two-way TWAMM demand is real. Revisit only with concrete user requests.

**Cost**: ~150-300 lines new executor module, 1-2 weeks + heavy audit.

## What NOT to do

Gemini Antigravity (2026-04-20) suggested adding passive-trigger TWAMM execution into **core pool's swap function**. Rejected because:
- Violates "features → satellites" rule (`feedback_no_core_upgrade.md`)
- Taxes all core users with gas for a feature they don't use
- Cross-package callback in Aptos is not free (V4's Singleton advantage doesn't translate)
- Requires core upgrade for a non-security reason

If we want passive-style execution, do it at the satellite layer (bounty executor, Candidate A), not in core.

## Triggers to revisit

- Candidate A: consider if keeper bot has downtime incident, OR if we see TWAMM volume that one keeper can't tick fast enough
- Candidate B: consider only if users explicitly request two-way simultaneous orders at same pool

---

## Round 5 audit cycle — additional V2 candidates (2026-04-20)

Collected from 5-auditor green cycle (Opus self, Gemini 3 Flash, Kimi K2.5 source-verified, Grok, Qwen). All items advisory/info, deferred from R5.1 to avoid audit-clock restart.

### Candidate C: `OrderCreated` event in `create_order`

**Why**: enable full off-chain lifecycle tracking (create → execute*N → cancel/complete). Scanner/keeper bot can subscribe to topic instead of scanning TX history. Error correlation: link aborted `execute_virtual_order` txs back to specific orders for debugging. Analytics: size/duration/pair distribution, slippage realized vs expected, fill rate per order.

**How**: add `#[event] struct OrderCreated { owner, order_address, token_in, token_out, amount_in, duration_seconds, start_time, end_time, timestamp }`. Emit at end of `create_order`. ~10 lines.

**Cost**: compat upgrade, near-zero risk (additive). Bundle with next V2 upgrade to avoid single-purpose audit round.

**Credit**: Grok (R5 external review).

### Candidate D: Per-pair `MAX_EMA_DEVIATION` config

**Why**: current flat 5× gate is loose for stable pairs (USDC/USDT normal <1%) and possibly fine for volatile pairs. Making this per-pair lets oracle gate fit pair-specific volatility.

**How**: `table::Table<address, u128>` keyed by `darbitex_arb_pool`, admin-configurable. Fallback to default 5×.

**Blocker**: adds admin surface (another privileged function) + requires per-pair operational tuning. Decide: static per-pair defaults, or dynamic config?

**Credit**: Gemini 3 Flash (R5 initial), Kimi (R5 NB-3 cross-ref), Qwen (F-4).

### Candidate E: `force_update_oracle` deviation bound from previous

**Why**: defense-in-depth. Current function lets admin set any positive (reserve_in, reserve_out). 3/5 multisig is the trust boundary but code-level bound would prevent single-step manipulation.

**How**: `assert!(new_reserve_in <= prev_reserve_in * MAX_FORCE_DEVIATION && new_reserve_in * MAX_FORCE_DEVIATION >= prev_reserve_in, E_FORCE_DEVIATION_EXCEEDED)`. Same for reserve_out.

**Tradeoff**: bounds recovery flexibility. If oracle stale during a huge external market move, admin can't catch up in one step.

**Verdict**: apply only if observed malicious admin-like behavior in V1, or if external ops audit flags it. Otherwise stay with 3/5 multisig trust.

**Credit**: Kimi K2.5 (R5 Finding-2 revised).

### Candidate F: Pool-vs-EMA magnitude cross-check before blend

**Why**: pre-existing NB-3 advisory from R3. Gate uses trade ratio (`actual_amount_out / amount_to_swap`), blend uses pool snapshot — semantic mismatch. Sandwich attacker could pass trade-ratio check while feeding manipulated pool state into EMA.

**How**: before committing blend, check `pool_r_in / oracle.reserve_in` and `pool_r_out / oracle.reserve_out` both within ≤2× delta. Skip blend if outside.

**Existing mitigations**: 10%/update smoothing, 5× trade-ratio gate, keeper whitelist, MIN_SWAP_FOR_EMA. Sustained manipulation already very difficult.

**Credit**: Opus R3 iter-3 NB-3, Kimi / Qwen F-4 corroboration.

### Candidate G: `cancel_order` idempotent guard (tiny)

**Why**: Qwen F-2 — calling `cancel_order` twice wastes gas + emits zero-amount event. Minor.

**How**: `assert!(order.remaining_amount_in > 0, E_NO_ORDER)` at function entry.

**Tradeoff**: user pays own gas; not protocol concern. Apply if convenient during next upgrade, skip otherwise.

**Credit**: Qwen.

### Candidate H: Multi-pair support (per-pool oracle storage)

**Why**: DeepSeek O-3. Current design stores `EmaOracle` singleton at `@darbitex_twamm`, meaning one TWAMM package deployment supports exactly one token pair. Additional pairs require fresh package redeploy. Operational scaling constraint.

**How**: replace `struct EmaOracle has key` at module address with `Table<address, OraclePair>` keyed by `darbitex_arb_pool` (or token-pair hash). Every place `borrow_global_mut<EmaOracle>(@darbitex_twamm)` becomes `table::borrow_mut(&mut table, pool_key)`. Similarly `init_ema_*` functions take pool address as argument.

**Blocker**: storage layout change = compat-incompat. Requires fresh package, NOT upgrade. If we commit to V1 single-pair, V2 multi-pair is a separate package (e.g., `darbitex_twamm_v2`) with migration path for in-flight orders (drain V1 first, redirect new orders to V2).

**Verdict**: defer until we see demand for 3+ pairs. For V1, single-pair per deploy is acceptable — spawn a new multisig + package per pair as needed (same pattern as Aptos native asset pairs).

**Credit**: DeepSeek O-3.

### Candidate I: `E_ORDER_EXPIRED` same-second UX

**Why**: OpenHands R5 observation. `assert!(now > last_executed_time, E_ORDER_EXPIRED)` at `execute_virtual_order:203` fires when keeper ticks in the same `now_seconds()` as `create_order` — semantically misleading ("expired" sounds terminal, actually just "too soon").

**How**: change `>` to `>=` (safe because `amount_to_swap == 0 → return` at `:220` already prevents same-second double-execute state changes). Rename error to `E_TIME_NOT_ADVANCED`. Alternative: keep `>`, just rename error.

**Tradeoff**: rename = breaking error code for off-chain indexers parsing error strings. Minor. Bundle with other V2 changes.

**Credit**: OpenHands.

## Pre-deploy verification checklist (non-V2, do before mainnet publish)

Items that don't require code changes but must be confirmed before `aptos move publish` fires.

1. **Aave flash loan fee = 0 on Aptos mainnet (DeepSeek O-4)**
   - `bridge.move:100` calls `flash_loan_simple(..., 0u16)`. The `0u16` is `referralCode`, not fee.
   - Fee is set by Aave's protocol config, not caller.
   - `feedback_aave_flash_standard.md` confirms 0-fee assumption held as of hyperion-router deploy (2026-04-17).
   - **Re-verify**: `aptos move view --function-id <aave_pool>::pool_configurator::get_flash_loan_fee --args address:<asset>` or inspect protocol state. If fee > 0, MEV leg math assumes free loan and may produce E_CANT_REPAY on marginal arbs.

2. **Thala pool address valid + liquid**
   - Before first `execute_virtual_order`, verify `thala_pool` argument points to a real ThalaSwap V2 pool with non-trivial liquidity.
   - Prevents DoS from keeper wasting gas on dead pools.

3. **Darbitex arb pool orientation matches oracle assumption**
   - `init_ema_from_pool` orientation logic at `twamm.move:149-157` must be verified against `darbitex_arb_pool`'s actual (meta_a, meta_b) assignment. Dry-run view function before submitting init tx.

4. **Keeper bot profile has sufficient gas balance**
   - Tick failures from OOG are indistinguishable from logic failures in logs. Top up keeper wallet to 2+ APT before enabling.

### Candidate J: Multi-venue TWAMM (Hyperion + Cellana) — **PRIMARY V2 TARGET**

**Historical context — this is a REGRESSION RESTORE, not greenfield.**

At R1 bridge already had three venue variants: `omni_swap_thala_twamm`, `omni_swap_hyperion_twamm`, `omni_swap_cellana_twamm`. R2 audit (see `AUDIT-R2-BUNDLE.md:9` M-1 finding) flagged the Hyperion/Cellana variants as "dead code" because executor only called the Thala one, and **deleted** them instead of adding the dispatcher. R3-R5 audit cycle did not revisit this decision, so V1 ships Thala-only.

The `omni_swap` prefix in the remaining function name is the rhetorical tell: "omni" implies multi-venue, but we only kept one venue. This is a known debt.

**Why this is PRIMARY target (not just one of many V2 items)**:
- It's the **original design intent** per R1; current state is a regression
- Flashbot satellite already proves the multi-venue pattern works on Aptos (`run_arb_hyperion` + `run_arb_cellana` both live in production)
- Single-venue TWAMM leaves liquidity on the table for APT pairs that Hyperion CLMM or Cellana stable/volatile serve better than Thala

**How**:
- Add `bridge::omni_swap_hyperion_twamm` + `bridge::omni_swap_cellana_twamm` (friend-only), matching the pattern already deployed on flashbot (`run_arb_hyperion`, `run_arb_cellana`)
- Executor dispatches on venue — either via `venue: u8` param to `execute_virtual_order`, or three parallel entry functions
- Each new bridge fn handles venue-specific signatures:
  - Hyperion: `a_to_b: bool` + `Object<LiquidityPoolV3>`
  - Cellana: `is_stable: bool` + no pool object (router auto-resolves by pair)

**Trigger to revisit (always-on, not conditional)**:
- This is the **first** V2 upgrade target when the bundling strategy below executes. Do not gate on "observed demand" — the capability has always been intended.

**Cost**: ~60-100 lines bridge + 20 lines executor dispatcher, one R-round audit, compatible upgrade (storage unchanged).

**Credit**: user flag post-smoke (2026-04-20) — pointed out that V1 Thala-only contradicts `omni_swap` naming + R1 original design.

## Bundling strategy

**First V2 upgrade (priority)**: Candidate J (multi-venue) is the headline feature — restores R1 design intent. Bundle trivial additive changes C (OrderCreated event) + G (cancel_order guard) + I (`E_TIME_NOT_ADVANCED` rename) with J in the same upgrade. Single audit round covers all four.

**Second V2 upgrade**: D/E/F (per-pair MAX_EMA_DEVIATION, force_update_oracle deviation bound, pool-vs-EMA cross-check) — these touch oracle-security surface and merit their own audit focus. Trigger: after multi-venue J proven stable on mainnet.

**Separate V2 package**: Candidate H (multi-pair per package) is compat-incompat — requires fresh `v2` package with new storage layout. Defer until demand signal (3+ pairs requested).

Candidates A + B (earlier section) stay deferred until real V1 behavior observed.
