# DeepSeek R1 — Darbitex Final

**Auditor:** DeepSeek V3 (DeepSeek, fresh web session)
**Code reviewed:** R1 submission
**Verdict:** 🟢 GREEN (ready with minor improvements)

---

## Findings

### HIGH: none

### MEDIUM: none

### LOW-1: Unbounded pagination in `fetch_all_sister_pools` may enable gas DoS
- **Location:** `arbitrage.move:fetch_all_sister_pools`
- **Description:** Loop over `pool_factory::pools_containing_asset` in PAGE-sized chunks until exhausted. Attacker can create many low-liquidity pools for a popular asset (e.g., APT) with minimal capital (1 wei per side). `simulate_leg` skips zero-output pools but loop still iterates performing `pool_tokens`, `reserves`, `compute_amount_out` per pool.
- **Impact:** Potential DoS on arbitrage functions, though attacker must lock capital in each pool. Economic cost may limit practical exploitation. Design has no explicit upper bound.
- **Recommended fix:** Hard limit on pools per asset (50-100) at factory level, OR gas budget terminating DFS after fixed pool visits. OR document trade-off and monitor mainnet.

### LOW-2: Unused `directions` field in Path struct (NEW finding)
- **Location:** `arbitrage.move:Path` struct
- **Description:** `directions: vector<bool>` is stored in Path but never consumed by execution. `execute_pool_list` only uses `pools`, inferring direction from FA metadata via pool::swap. `directions` is populated during DFS and exposed in quote views only.
- **Impact:** No security impact; dead storage that could be removed to reduce struct size and gas costs.
- **Recommended fix:** Remove `directions` from `Path` if not needed. If kept for off-chain clients, document informational only.

### INFORMATIONAL-1: Duplicate reserve check in find_best_flash_triangle
- Duplication improves error clarity (skip candidate vs opaque abort). Acceptable.

### INFORMATIONAL-2: compute_direct_baseline returns 0 for from == to
- Consistent with "cycle uses amount_in as baseline" rule. Sound.

---

## Q1-Q10 answers
All CORRECT. Highlights:

- **Q1:** DFS correct. `find_best_flash_triangle` paginates complete via `fetch_all_sister_pools`. Gas O(N^K) acceptable.
- **Q2:** Determinism holds. Re-checks load-bearing safety net.
- **Q3:** `compute_direct_baseline` watertight via canonical lookup. Fallback executes identically to direct pool::swap.
- **Q4:** Flash topology correct. Liquidity pre-check mirrors flash_borrow exactly.
- **Q5:** No authorization gap. No FA leak. No &signer in pool::swap is safe.
- **Q6:** Receipt handling correct. Abort drops via TX revert.
- **Q7:** Beta delta preserves all invariants.
- **Q8:** Dust handling standard.
- **Q9:** No overflow paths. Rounding in caller's favor.
- **Q10:** No dead code (except directions field), no admin surface, correct visibility.

---

## OQ answers
- **OQ-1:** Keep as is. No factory cap. Optional soft budget as precaution.
- **OQ-2:** **Canonicalize.** Recommend `metadata_out` + `canonical_pool_address_of`.
- **OQ-3:** 4/5 sufficient for launch.
- **OQ-4:** **Yes, canonicalize.** Recommend change.
- **OQ-5:** Keep pre-pass.
- **OQ-6:** Let caller shoot foot. Don't abort.
- **OQ-7:** Accept spoofing.

---

## Overall verdict
**🟢 GREEN** — Ready for mainnet with minor improvements:
1. Canonicalize swap_entry and swap_compose
2. Remove unused `directions` field
3. No blocking security issues

Codebase well-structured, beta delta clean, arbitrage module "novel but sound design". Pre-audit self-review addressed all major concerns. Deploy with `compatible` upgrade policy + planned multisig threshold.
