# Kimi R1 — Darbitex Final

**Auditor:** Kimi K2 (Moonshot AI, fresh web session)
**Code reviewed:** R1 submission
**Verdict:** 🟢 GREEN (with MEDIUM-1 fix recommended pre-publish)

---

## Findings

### HIGH: none

### MEDIUM-1: `swap_compose` direct_pool gaming creates treasury overpayment vector
- **Location:** `arbitrage.move:swap_compose`
- **Description:** Caller-nominated `direct_pool` allows passing shallow/illiquid pool as baseline, artificially inflating "improvement" and causing excess treasury extraction up to 10% of nominated baseline rather than true market baseline.
- **Concerns:**
  1. UX footgun — users may unknowingly overpay
  2. Violates "service charge on value added" principle when baseline manipulated
  3. **API asymmetry** with `execute_path_compose` (canonical lookup via `compute_direct_baseline`)
- **Impact:** Economic leakage from users to treasury due to API asymmetry; philosophical inconsistency.
- **Recommended fix:** Canonicalize the baseline lookup via `pool_factory::canonical_pool_address_of(in_addr, out_addr)`. Remove `direct_pool` param, add `metadata_out: Object<Metadata>`. Creates API symmetry with `execute_path_compose`.

### MEDIUM-2 (downgraded to verification note): reserve pre-check analysis
- Initially flagged pre-check vs pool::flash_borrow assertion mismatch, but after re-reading both use strict inequality equivalently (`anchor_reserve > amount` ≡ `amount < anchor_reserve`). **Correct.** Documentation/verification note only.

### LOW-1: `execute_path_compose` permits sub-optimal path execution without warning
- **Location:** `arbitrage.move:execute_path_compose`
- **Description:** When caller passes `pool_path` yielding less than direct baseline, function executes anyway with `surplus = 0`. Documented as intentional (OQ-6), but creates UX issue: no event indicating "sub-optimal path taken", silent zero treasury cut could be misinterpreted as "no service charge applicable" rather than "path was worse".
- **Recommended fix:** Either:
  1. Add informational event `PathSubOptimal { expected_direct_out, actual_out }` when `actual_out < baseline`, OR
  2. Add optional `reject_if_suboptimal: bool` parameter (default true for entry, false for compose)

### LOW-2: `dfs_path` / `dfs_cycle` lack gas budgeting for unbounded DFS
- **Description:** O(N^K) scaling with MAX_HOPS=4 and MAX_CYCLE_LEN=5 — mature ecosystem (30 pools/asset) could hit ~810k operations worst-case. Move gas metering prevents infinite loops but no explicit budget for graceful degradation.
- **Impact:** UX degradation in mature ecosystems; unexpected out-of-gas aborts.
- **Recommended fix:** `max_gas_budget` param or pool-visit counter. Soft cap preserves liveness without hard ecosystem limits.

### LOW-3: `pool::swap` event attribution spoofing
- **Description:** `swapper: address` parameter spoofable at compose layer. Known tradeoff (OQ-7).
- **Alternatives considered:** (a) make `pool::swap` `public(friend)` to arbitrage only — breaks composability. (b) Accept spoofing.
- **Recommended fix:** Accept, document clearly.

### INFORMATIONAL-1: `TREASURY` address hardcoded without runtime validation
- **Description:** No runtime check that TREASURY is not `@0x0` or not-a-brick. Defense-in-depth only.
- **Recommended fix:** Add one-time init check that `TREASURY != @0x0`. Optional: check has code (multisig marker).

### INFORMATIONAL-2: `compute_direct_baseline` returns 0 for non-existent pools
- Verified correct: when baseline = 0, surplus = 0 (guarded by `baseline > 0 && actual_out > baseline`). Philosophically consistent ("no baseline = no charge").

### INFORMATIONAL-3: `MINIMUM_LIQUIDITY` dead shares correctly implemented
- Standard V2 behavior. Shares effectively burned by being sent to address with no claim mechanism.

### INFORMATIONAL-4: `FlashReceipt` hot-potato correctly implemented
- No abilities, consumed exactly once on success paths, dropped via TX rollback on abort. **Verified correct.**

### INFORMATIONAL-5: `accrue_fee` simplification preserves invariants
- Store conservation holds. Reserves track principal only. All fee value flows to LP accumulator. **Verified correct.**

---

## Q1-Q10 answers

- **Q1:** CORRECT with minor gas concerns. DFS pruning sufficient.
- **Q2:** CORRECT. Deterministic sim-to-exec. Post-checks load-bearing defense-in-depth.
- **Q3:** CORRECT with API asymmetry concern (MED-1).
- **Q4:** CORRECT. Hot-potato + topology exclusion sound.
- **Q5:** CORRECT. No authorization gap. Known spoofing is metadata-only.
- **Q6:** CORRECT. Pre-assert chain makes extract safe.
- **Q7:** CORRECT. Beta delta preserves all invariants.
- **Q8:** CORRECT. Dust handling standard.
- **Q9:** CORRECT. u256 prevents overflow.
- **Q10:** No additional findings.

---

## OQ answers
- **OQ-1:** Accept for launch. Add soft budget future compat upgrade.
- **OQ-2:** Canonicalize (this is MED-1 fix).
- **OQ-3:** Keep 4/5 for launch.
- **OQ-4:** Yes, canonicalize.
- **OQ-5:** Keep pre-pass.
- **OQ-6:** Add informational event (LOW-1), don't block.
- **OQ-7:** Accept as documented.

---

## Overall verdict
**🟢 GREEN — Mainnet publish readiness with MEDIUM-1 fix recommended**

Strengths:
- Clean separation between pool primitives and arbitrage logic
- Correct hot-potato pattern for flash loans
- Deterministic simulation-to-execution matching
- Uniform service charge application
- Proper pagination handling
- Defensive pre/post checks

Recommended pre-publish:
1. Fix MEDIUM-1 (canonicalize direct_pool in swap_compose)
2. Consider LOW-1 (sub-optimal path event)
3. Integration test with 4+ pools to activate flash-triangle path
