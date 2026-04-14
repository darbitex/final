# Claude (fresh web) R2 — Darbitex Final

**Auditor:** Claude Opus 4.6 extended (Anthropic web, fresh session — same author as R1)
**Code reviewed:** R2 (post-R1 fix batch + R1.5 hotfix)
**Verdict:** 🔴 RED (do not publish until HIGH-1 fixed) → 🟢 GREEN after fix

---

## R1 findings — disposition

| R1 Finding | Status | Verification |
|---|---|---|
| MEDIUM-1 (canonicalize `direct_pool`) | **FIXED** | `swap_compose` takes `metadata_out: Object<Metadata>`, baseline via `canonical_pool_address_of` |
| MEDIUM-2 (pool uniqueness in `execute_path_compose`) | **FIXED** | O(n²) duplicate check added |
| MEDIUM-3 (pre/post rounding gap) | ACKNOWLEDGED | Defense-in-depth, retained |
| LOW-1 (fee dust accumulation) | ACKNOWLEDGED | Standard V2 |
| LOW-2 (`E_SAME_TOKEN` redundancy in `create_pool`) | **FIXED** | Constant removed, assert replaced with comment |
| LOW-3 (`pools_containing_asset` silent clamping) | OPEN | Arbitrage module paginates correctly |

---

## New R2 findings

### 🔴 HIGH-1: `swap_compose` charges 10% treasury cut on ENTIRE output when no direct pool exists

**Location:** `arbitrage.move`, `swap_compose`, line 778

**Description:** The improvement computation is:
```move
let improvement = if (actual_out > direct_out) { actual_out - direct_out } else { 0 };
```

When no canonical direct pool exists between input and output assets, `direct_out = 0`. The guard `actual_out > direct_out` reduces to `actual_out > 0`, trivially true for any successful swap. `improvement = actual_out - 0 = actual_out`. Treasury takes **10% of the entire swap output**, not 10% of surplus.

Compare `execute_path_compose`, which handles this correctly:
```move
let surplus = if (baseline > 0 && actual_out > baseline) { ... } else { 0 };
```

The `baseline > 0 &&` guard ensures surplus = 0 when no baseline exists. `swap_compose` is missing this guard.

**Impact:** At launch with 3 pools, every pair has a direct pool → bug is dormant. The moment a 4th asset is introduced (e.g., stAPT via APT/stAPT pool without a USDC/stAPT pool), swaps like USDC→stAPT routed via USDC→APT→stAPT will silently lose 10% to treasury. Violates design principle §3.5 ("no direct pool = no charge, Darbitex is the only available route").

**Recommended fix:**
```move
let improvement = if (direct_out > 0 && actual_out > direct_out) {
    actual_out - direct_out
} else {
    0
};
```

### 🟡 LOW-1: `execute_path_compose` does not enforce MAX_HOPS on caller-supplied paths
Minimal impact. Caller sovereignty at compose layer. Optional: `assert!(path_len <= MAX_HOPS, E_WRONG_POOL);`.

### 🔵 INFORMATIONAL-1: Stale docstrings
- `pool.move` header still says "The programmable `arbitrage` module is invoked via before/after callbacks inside `pool::swap`" — actual architecture has no callbacks.
- `swap_compose` module-level doc (line ~33) says "nominated direct-hop pool" — should be "canonical direct pool" after R1 canonicalization.

### 🔵 INFORMATIONAL-2: DFS budget decrements on skipped candidates
Budget decrements before `vector::contains(path_pools, ...)` check. Revisited pools consume budget without productive work. **Correct from gas-bounding perspective** (vector::contains itself costs gas). No action.

### 🔵 INFORMATIONAL-3: `find_best_flash_triangle` shared-budget starvation
Early-iteration candidates can consume most of the 256 budget, starving later candidates. Acknowledged trade-off. Attack economically marginal. No action required for launch. Future mitigation: (a) sort candidates by anchor_reserve descending, or (b) per-candidate floor like `max(16, budget / n)`.

---

## R1 fix batch validated (4/4)

1. **`DFS_VISIT_BUDGET = 256` with `&mut u64` threading** — cleanly solves OQ-1. Split between fresh-budget `find_best_cycle` wrapper and shared-budget `_internal` is a good API boundary.
2. **`Path.directions` removal** — correct simplification. Direction inferred from FA metadata at execution time.
3. **`swap_compose` canonicalized baseline** — mostly correct. The `assert!(in_addr != out_addr)` and `assert!(chosen.expected_out > 0, E_SLIPPAGE)` guards are excellent defensive additions. One critical miss: the HIGH-1 zero-baseline case (see above).
4. **Pool uniqueness check in `execute_path_compose`** — correctly implemented.

---

## Overall verdict
**🔴 RED — do not publish until HIGH-1 is fixed.**

HIGH-1 is a one-line fix (add `direct_out > 0 &&` guard). Once patched, package moves to **GREEN** for mainnet publish. Remaining LOW and INFO findings are acceptable for launch.
