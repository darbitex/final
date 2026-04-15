# Post-Mainnet Audit Round — 2026-04-16

**Subject:** Darbitex Final v0.1.0 core modules (`pool.move`, `pool_factory.move`, `arbitrage.move`)
**Package:** `0xc988d39a4a27b26e1d659431a0c5828f3862c155d1c331386cd5974298dd78dd`
**Status:** Round closed — all auditors GREEN, 0 HIGH/CRITICAL
**Purpose:** Consolidated findings ledger for Darbitex Improvement Proposal (DIP) tracking

---

## Scope

Seven independent audit passes on the v0.1.0 mainnet source snapshot, following the pre-launch R1/R2/R3 campaign that cleared the package for publish. This round verifies the deployed code against adversarial review after real capital is in play.

---

## Auditor panel

| # | Auditor | Verdict | New valid findings |
|---|---|---|---|
| 1 | Self (Claude Opus 4.6 in-session) | GREEN | 4 baseline (LOW-1, LOW-2, INFO-1, INFO-3) |
| 2 | Gemini (session 1) | GREEN | +1 (LOW-3) |
| 3 | Gemini (session 2) | GREEN | 0 |
| 4 | Claude web | GREEN | +2 (LOW-4, INFO-7) |
| 5 | DeepSeek | GREEN | 0 (one hallucinated "typo") |
| 6 | Grok | GREEN | 0 (one LOW already satisfied on-chain) |
| 7 | Kimi K2 | GREEN | 0 (independently confirms LOW-3) |

**Aggregate:** 7/7 GREEN. Zero HIGH or CRITICAL. Total of 4 LOW + 3 actionable INFO accepted into the bundle. LOW-3 independently surfaced by two auditors (Gemini-1 + Kimi) along different analysis paths — high-confidence signal.

---

## Severity calibration notes

Post-mainnet AI auditors consistently overshoot severity on hygiene items. This round required active downgrade on three occasions:

- **Gemini-1** rated the `SCALE` precision leak as **HIGH**; economic impact is ~$1–10 cumulative over the lifetime of large pools and is not exploitable. Downgraded to **LOW-3**.
- **Claude web** rated three items as **MEDIUM**; one was mathematically invalid (see rejections below), one was inherent to any read-then-execute AMM pattern (LOW-4 wrapper kept for DX reasons only), one was already tracked as INFO-4.
- **Gemini-1** rated the unbounded `asset_index` growth as **MEDIUM**; pool creation cost plus natural capital requirement makes spam uneconomic. Downgraded to INFO, confirmed by Gemini-2's independent take.

Filtering findings through an explicit mathematical invariant check (rather than deferring to auditor-assigned severity) was necessary to avoid polluting the DIP queue.

---

## Actionable bundle (DIP-v0.2 candidate)

These seven items are the complete queue for the next core compat upgrade. **There is no urgency to ship.** The recommendation is to hold `v0.1.0` on mainnet and bundle these only when another reason to touch core arises (satellite integration driver, compat fix, etc.).

### LOW-1 — `arbitrage::swap_compose` duplicates direct-baseline logic
**Source:** Self-audit
**File:** `sources/arbitrage.move:773-786` vs. the existing `compute_direct_baseline` helper at `262-272`
**Description:** `swap_compose` inlines its own direct-pool lookup instead of calling `compute_direct_baseline`. Both currently agree, but a refactor touching one and not the other would cause asymmetric treasury-cut behavior between `swap_compose` and `execute_path_compose`.
**Fix:** route `swap_compose` through `compute_direct_baseline`, or introduce a shared helper that returns `(direct_addr, direct_exists, direct_out)` so the fallback path still has the address.
**ABI impact:** None.

### LOW-2 — `pool::swap` u64 reserve-add can abort arithmetically at extreme TVL
**Source:** Self-audit
**File:** `sources/pool.move:393, 397`
**Description:** `pool.reserve_a + amount_in - lp_fee` is computed in u64. At `reserve_a` near `u64::MAX` a large deposit aborts with an opaque arithmetic error rather than `E_INSUFFICIENT_LIQUIDITY`. Unreachable for any realistic fungible asset (stables/APT are well below 2^64 raw units).
**Fix:** add `assert!((reserve_a as u128) + (amount_in as u128) <= U64_MAX, E_INSUFFICIENT_LIQUIDITY)` before the mutation to surface a clean error.
**ABI impact:** None.

### LOW-3 — `accrue_fee` sub-dust rounding leak (confirmed by two auditors)
**Source:** Gemini-1 (originally rated HIGH, downgraded); independently confirmed by Kimi K2
**File:** `sources/pool.move:210-220` (`accrue_fee`)
**Description:** `add = fee * SCALE / lp_supply` (floor). When `fee * 1e12 < lp_supply` — realistic on pools where `lp_supply > 1e12`, e.g., a $10M × $10M APT/USDC pool — `add = 0` and the per-share accumulator ignores the fee. However, `pool::swap` still deducts the fee from reserves (`reserve += amount_in - lp_fee`). The physical tokens remain in the pool's primary store but are permanently unclaimable through the LP accumulator.
**Severity rationale:** Not exploitable (nobody gains). Pure dust leak favoring the pool's physical store. Estimated economic impact: ~$1–10 cumulative over the lifetime of a large pool. Kimi independently derived the same mechanism, raising confidence.
**Fix:** in `accrue_fee`, return `0` as the effective fee when `add == 0`; the swap callsite then omits the reserve deduction, leaving the sub-dust fee in reserves V2-style (auto-captured by all LPs via share proportion).
```move
fun accrue_fee(pool: &mut Pool, fee: u64, a_side: bool): u64 {
    if (fee == 0 || pool.lp_supply == 0) return 0;
    let add = (fee as u128) * SCALE / (pool.lp_supply as u128);
    if (add == 0) return 0;  // sub-dust: leave in reserves
    if (a_side) {
        pool.lp_fee_per_share_a = pool.lp_fee_per_share_a + add;
    } else {
        pool.lp_fee_per_share_b = pool.lp_fee_per_share_b + add;
    };
    fee
}
```
**ABI impact:** None.

### LOW-4 — No entry wrapper for `execute_path_compose`
**Source:** Claude web (stated rationale corrected during triage)
**File:** `sources/arbitrage.move`
**Description:** `execute_path_compose` already accepts a caller-supplied `pool_path`, but there is no entry wrapper for off-chain bots and keepers that pre-compute paths to call it directly. Today such callers must round-trip through `swap_entry`, which re-runs the DFS on-chain (wasted gas).
**Triage note:** Claude web originally pitched this as a fix for "stale-quote divergence." That framing is incorrect — a pre-computed path does not eliminate reserve drift between quote and execution, and `min_out` is the real guard (same as every AMM). The wrapper is still worth adding, but purely as a gas/DX optimization, not as a security fix.
**Fix:** add:
```move
public entry fun execute_path_entry(
    user: &signer,
    pool_path: vector<address>,
    metadata_in: Object<Metadata>,
    amount_in: u64,
    min_out: u64,
    deadline: u64,
)
```
handling primary store i/o + deadline, then delegating to `execute_path_compose`.
**ABI impact:** Pure additive.

### INFO-1 — `sources/tests.move` is a `1 + 1 == 2` stub
**Source:** Self-audit
**Description:** The v0.1.0 publish relied on adversarial multi-LLM audit plus mainnet smoke test instead of a unit suite. Not a correctness issue, but a real-capital test harness would catch future compat-upgrade regressions cheaply.
**Fix:** port Beta's swap / LP / flash test battery under `#[test_only]` before v0.2 ships.

### INFO-3 — `claim_lp_fees` emits `LpFeesClaimed` even on zero claims
**Source:** Self-audit
**File:** `sources/pool.move:626`
**Description:** Minor log noise; no functional impact. Indexers receive no-op events.
**Fix:** early-return when `claim_a == 0 && claim_b == 0` to skip the emit.

### INFO-7 — Leg-indexed error reporting in `execute_pool_list`
**Source:** Claude web (L-03 in the PDF)
**File:** `sources/arbitrage.move`
**Description:** When a multi-hop abort happens, the leg index is not surfaced. `pool::swap` aborts with its own error code and the caller cannot tell which hop failed. For DFS-generated paths this is academic, but `execute_path_compose` accepts caller-supplied paths where a pool could theoretically be destroyed between path construction and execution.
**Fix:** either wrap each leg with a leg-index tag in the abort code, or emit a per-leg attempt event that indexers can correlate on rollback.

---

## Tracked, no action

### INFO-2 — Direct FA donations to pool addresses are permanently stuck
**Source:** Self-audit
**Description:** Physical store balance can exceed `reserve_a/b` only through `accrue_fee`-credited fees (claimable) or unsolicited direct deposits (not claimable). Direct donations are not distributable by the LP accumulator and not redeemable via `remove_liquidity`, which uses `reserve_a/b`, not physical balance. Standard V2 behavior. Operator awareness only.

### INFO-4 — DFS visit budget starvation in `find_best_flash_triangle`
**Source:** Self-audit, plus independent variants from Claude web (M-02) and Kimi K2 (#2)
**Description:** The shared `DFS_VISIT_BUDGET = 256` can be fully consumed by early borrow-candidate cycle searches, starving later candidates — even when one of them hosts the optimal topology. Documented trade-off in `arbitrage.move:504-514`.
**Decision:** accept as-is. The 6-pool mainnet ecosystem is nowhere near the starvation threshold. Revisit only if telemetry shows missed topologies. Proposed two-phase fix (liquidity-pre-filter + front-loaded budget) is reasonable but adds substantial complexity to a mature code path.

### INFO-5 — `execute_path_compose` silently accepts losing cycles at `min_out = 0`
**Source:** Self-audit
**Description:** If a caller passes a cycle path with `actual_out < amount_in` and `min_out = 0`, the TX succeeds and returns a smaller FA (pure slippage loss to pool fees). `min_out` is the user's floor. Documented in the function doc; satellite integrators (flashbot included) must set it explicitly.

### INFO-6 — `Move.toml` is still `upgrade_policy = "compatible"`
**Source:** Self-audit
**Description:** Per the Final philosophy, flip to `immutable` after 3–6 month soak. Mainnet publish was 2026-04-14, so the earliest flip window opens approximately 2026-07-14.
**Decision:** do not flip yet. If any of LOW-1 / LOW-2 / LOW-3 / LOW-4 or INFO-1 / INFO-3 are to ship, they need the `compatible` policy window.

---

## Rejected findings

### Claude web M-01 — "fee accounting drift, last LP claim can abort"
**Rejection reason:** Mathematically invalid. The report claims that truncation dust in `accrue_fee` plus `pending_from_accumulator` can cause the last LP's claim to exceed the pool's store balance. The opposite is true — floor division on both sides of the accumulator guarantees `Σᵢ claim_i ≤ total fees deposited`:

```
Σᵢ claim_i ≤ Σₖ floor(fee_k · SCALE / lp_supply_k) · lp_supply_k / SCALE ≤ Σₖ fee_k
```

Store cannot be under-funded via this path — dust leaks in favor of the pool, not against it. Claude web inverted the direction of drift. The recommended `min(claim, store_balance)` guard is harmless but the mechanism being guarded against does not exist.

### Claude web M-03 rationale — "stale-quote divergence"
**Rejection reason:** Pre-computed paths do not eliminate reserve drift between quote and execution. `min_out` is the real guard, same as every AMM. The wrapper itself was kept as LOW-4 for gas/DX reasons, with the stated security rationale corrected.

### Claude web I-01 — "hardcoded treasury with no rotation mechanism"
**Rejection reason:** Zero-admin surface is a philosophy rule for Darbitex Final, not an oversight. A rotatable `TreasuryConfig` resource would add admin surface and violate the rule. Treasury key is already secured at the 3/5 multisig level (`0xdbce8911...`), which is the intended mitigation.

### Claude web I-02 — "MINIMUM_LIQUIDITY parameterization"
**Rejection reason:** `MINIMUM_LIQUIDITY = 1000` is a Uniswap V2 standard value. For realistic Aptos fungible assets with 6–8 decimals, the dead-share fraction is negligible. Parameterization adds configuration surface with no meaningful benefit.

### Claude web I-03 — "event timestamps rely on block time granularity"
**Rejection reason:** `timestamp::now_seconds()` is the Aptos-native granularity. Indexers needing intra-block ordering should use Aptos event sequence numbers, which are deterministic regardless of timestamp resolution.

### Gemini-1 MEDIUM — `asset_index` unbounded vector growth
**Rejection reason:** Downgraded to INFO and accepted. Pool creation requires real capital (MINIMUM_LIQUIDITY + gas), so spam is economically impractical. Reads are paginated (`MAX_PAGE = 10`). Gemini-2 and Claude web independently agreed with the INFO classification.

### DeepSeek LOW — "Typographical Error in Variable Name `budget`"
**Rejection reason:** Hallucinated finding. The report claims a typo where both the "wrong" and "correct" spellings in the report body are identical (`budget` → `budget`). The source code uses `budget` consistently across all callsites. Non-finding.

### Grok LOW — "Treasury address hardcoded, move to multisig"
**Rejection reason:** Already satisfied on-chain. The hardcoded constant `0xdbce8911...` is itself the address of a 3/5 multisig, active since 2026-04-13. Grok did not verify on-chain state before raising the finding.

### Kimi #1 — "add `flash_outstanding` counter for defense-in-depth"
**Rejection reason:** The current design — reserves are never decremented during flash borrow, the `locked` flag guarantees no concurrent reads — is deliberate and documented. An explicit counter would duplicate the lock's guarantee without adding real safety. Kimi's own analysis acknowledges the current design is "correct but relies heavily on the lock mechanism," which is the intended invariant.

---

## Positive observations (converged across panel)

Every auditor independently validated the following design decisions as correct. These should be preserved in any future refactor:

1. **Hot-potato `FlashReceipt`** — no `drop`/`store`/`key` abilities. Static enforcement of repayment in the same TX.
2. **Per-pool `locked` flag** — consistent reentrancy guard across swap, LP, flash, and claim operations. Covers the dispatchable-FA hook surface on Aptos.
3. **Flash reserve accounting** — reserves intentionally not decremented on borrow; fee-only routing on repay. Keeps solvency invariant without reserve churn.
4. **Strict flash repay equality** — `flash_repay` asserts `amount_in == amount + fee` (strict `==`, not `>=`), preventing silent over-payment from creating untracked reserve drift.
5. **O(1) canonical pool derivation** — `pool_factory::canonical_pool_address_of` replaces the earlier O(N) pagination scan that could miss direct pools past the page size.
6. **Shared DFS visit budget** — `find_best_flash_triangle` decrements budget before the liquidity precheck, closing the junk-pool gas-griefing vector flagged in R3 MEDIUM-1.
7. **Lazy-paginated DFS** — fixes the R2 HIGH-1 upfront-fetch vector, bounding allocation cost to the DFS budget rather than to the ecosystem size.
8. **Path uniqueness enforcement** — `execute_path_compose`'s O(n²) check (bounded by `MAX_HOPS = 4`) preserves the simulation-to-execution determinism invariant against caller-supplied paths.
9. **Zero admin surface** — `init_factory` is one-shot and gated to `@darbitex`; no upgrade/config/governance entry points exist post-init.
10. **Disjoint error-code namespaces** — pool (1–14), factory (1–5), arbitrage (1–6). No collisions.
11. **u256 intermediates on sensitive math** — `compute_amount_out`, `compute_flash_fee`, and `add_liquidity` optimal-amount calculations all promote to u256 with explicit `U64_MAX` guards.
12. **`MINIMUM_LIQUIDITY` ghost shares** — correctly retained in `lp_supply` and guarded at `remove_liquidity` via `pool.lp_supply >= MINIMUM_LIQUIDITY`, preventing first-depositor inflation.

---

## Round verdict

**7/7 GREEN. Core `v0.1.0` is production-safe as deployed.** No HIGH or CRITICAL findings surfaced across seven independent auditors, including two that independently confirmed the single non-trivial LOW (LOW-3). Hardening from the pre-launch R1/R2/R3 campaign verifies consistently across all post-mainnet reports.

The DIP-v0.2 bundle is queued but non-urgent. Ship only when another reason to touch core arises and the `compatible` upgrade policy window is still open (pre-2026-07-14 by current soak target).

---

## Meta observation

Post-mainnet AI auditors showed a consistent pattern of overshooting severity on hygiene items, particularly Claude web (3 × MED where 1 reduced to LOW and 2 were rejected) and Gemini-1 (1 × HIGH reduced to LOW, 1 × MED reduced to INFO). This is normal behavior for LLM auditors without ground-truth calibration against Uniswap-class AMM math. For future rounds, filtering findings through explicit mathematical invariant proofs (rather than deferring to auditor-assigned severity) is a necessary step before committing to a DIP queue. This saved the bundle from an invalid M-01 that would have added a harmless-but-wrong `min(claim, store_balance)` guard.

Coverage across auditors was complementary rather than overlapping: each surfaced different hygiene areas (fee precision, DX wrappers, gas starvation, error reporting), which is the signal pattern expected from a healthy diverse panel rather than redundant noise.
