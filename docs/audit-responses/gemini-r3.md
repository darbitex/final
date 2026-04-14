# Gemini R3 — Darbitex Final

**Auditor:** Gemini 2.5 Pro (Google, fresh web session — same auditor as R1+R2)
**Code reviewed:** R3.1 submission (post all fixes: R1 batch + R1.5 + R2.1 + R2.2 + R3.1)
**Verdict:** 🟢 GREEN — Ready for Mainnet

---

## Findings

### HIGH: None
"The R2 HIGH vulnerabilities have been successfully remediated. The DoS vector via `fetch_all_sister_pools` is completely closed by the inlined, lazy-paginated DFS traversal."

### MEDIUM: None
"The mathematical invariants around the LP fee accumulator, flash loan k-invariant, and x × y = k swap logic remain robust after the beta refactors."

### LOW: None

### INFORMATIONAL-1: Flash-triangle discovery sensitive to asset_index ordering
- Shared `DFS_VISIT_BUDGET` across flash-triangle means order of borrow candidate evaluation matters. First few candidates with deep pool graphs can exhaust 256-tick budget during internal `find_best_cycle` searches. Later candidates in factory index never evaluated.
- **Impact:** Sub-optimal routing in mature ecosystems. Not a security risk.
- **Recommended fix:** None required. "This is the correct mathematical tradeoff to make to prevent gas-exhaustion DoS."

---

## Verification of R2.1 + R2.2 + R3.1 fixes

1. **✅ `swap_compose` zero-baseline guard (R2.1):** *"Perfectly implemented. Aligns seamlessly with 'no baseline = no charge' philosophy and correctly mirrors `execute_path_compose`."*

2. **✅ Lazy pagination in DFS (R2.2 — dfs_path / dfs_cycle):** *"Watertight. Budget is correctly decremented before candidate evaluation, and page fetching stops immediately when the budget hits zero."*

3. **✅ Lazy pagination in find_best_flash_triangle (R2.2 + R3.1 outer-loop budget fix):** *"Decrementing the budget by 1 for the candidate before the liquidity pre-check was an excellent catch (mitigates the Claude R3 MED-1 concern). The &mut budget safely threads the remaining ticks into the cycle search."*

4. **✅ u128 cast for treasury math (R3.1 Kimi MED-1 fix):** *"Silent update to `(((surplus as u128) * (TREASURY_BPS as u128) / (TOTAL_BPS as u128)) as u64)` across the compose layer safely guarantees no u64 overflow on massive swap surpluses."*

**All 4 fix batches verified working as intended by the auditor who was most adversarial in R1/R2.**

---

## Design question answers

### SmartVector sharding (tiebreaker for Gemini R2 MED-1 open question)
**"Do NOT block the launch for this. Treat it as a compat-upgrade item for the soak window."**

> "Aptos storage is significantly more forgiving than EVM. While pushing to a massive vector inside a Table bucket does increase gas due to deserialization/serialization costs, it will not brick the contract at realistic near-term scales (even 1,000+ pools). If Darbitex scales to the point where pool creation gas becomes a UX friction point, you can confidently upgrade the factory to use `aptos_std::smart_vector` during the `compatible` window without halting the core AMM."

**Clean resolution** of the open question left for R3 consensus.

### OQ-1: Unbounded sister-pool count + DFS budget
"The lazy-paginated DFS combined with DFS_VISIT_BUDGET is the optimal solution."

### OQ-2 & OQ-4: Canonicalize API
"Exactly the right move. Removes a UX footgun, prevents self-harming execution paths, and locks the service charge to an undeniable, objective mathematical baseline."

### OQ-3: MAX_HOPS=4 / MAX_CYCLE_LEN=5
"These constants are perfect. 4 hops cover 99% of viable retail arbitrage routes. 5 cycle legs easily cover standard triangles and quad-arbs."

### OQ-5: execute_path_compose pre-pass
"Keep. O(N) reads for validation are negligible in cost."

### OQ-6: Refusing sub-optimal paths
"Let the caller shoot themselves in the foot. A foundational primitive must remain strictly neutral."

### OQ-7: Caller parameter spoofing
"Accept (c). Event spoofing is a well-known limitation of pure FA-in/FA-out composability."

---

## Overall verdict

**🟢 GREEN — Ready for Mainnet**

> *"The architecture is clean, the fallback logic is flawless, and the protection mechanisms against both economic manipulation and execution-halting DoS are mathematically sound. The separation of the immutable x × y = k core from the opinionated, programmable routing layer is a masterclass in modern Move design. Proceed to publish."*
