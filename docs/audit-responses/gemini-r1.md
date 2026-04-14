# Gemini R1 — Darbitex Final

**Auditor:** Gemini 2.5 Pro (Google, fresh web session)
**Code reviewed:** R1 submission (commit pre-audit baseline, post self-review fixes M-1..M-4, L-1..L-3)
**Verdict:** 🟡 YELLOW (fix required before mainnet)

---

## Findings

### HIGH-1: Trivial Gas Exhaustion DoS via Unbounded DFS
- **Location:** `arbitrage.move` (`fetch_all_sister_pools`, `dfs_path`, `dfs_cycle`) & `pool_factory.move` (`index_asset`)
- **Description:** `pool_factory::create_canonical_pool` is permissionless. Anyone can create pairs of a core asset (e.g., APT) and arbitrary junk FAs. Each creation appends to `asset_index[APT]`. `fetch_all_sister_pools` paginates until exhaustion; DFS then explores every sister pool at every depth. An attacker can create 30–50 junk pools paired with APT for a few dollars of gas.
- **Impact:** Any call to `swap_entry`, `close_triangle`, or `close_triangle_flash` involving APT will trigger a DFS graph search that iterates O(N^K) times. With 50 pools, this will instantly hit the Aptos execution gas limit, entirely bricking the on-chain router for that asset.
- **Recommended fix:** Add a shared `&mut u64` counter passed through DFS recursion as an execution budget (e.g., max 100-200 node visits globally per search). If the budget hits 0, `return` early. Preserves unbounded ecosystem growth while protecting the module from intentional gas-griefing.

### MEDIUM-1: Inefficient Cross-Module Pagination in Recursion Loop
- **Location:** `arbitrage.move` (`fetch_all_sister_pools`)
- **Description:** `fetch_all_sister_pools` loops via cross-module calls to the factory at every depth of the DFS. An asset visited in multiple branches causes repeated re-pagination of the same factory index.
- **Impact:** Inflates normal gas costs significantly even in a healthy ecosystem.
- **Recommended fix:** Factory view returns up to a hard maximum (e.g., 20 pools) in a single call. If caller wants deep graph traversal across 50+ pools, they should compute off-chain and use `execute_path_compose` with a pre-computed path.

### LOW-1: Baseline Manipulation via Nominated `direct_pool`
- **Location:** `arbitrage.move` (`swap_compose`)
- **Description:** As suspected in OQ-2, allowing caller to nominate `direct_pool` means they can pass a pool with terrible liquidity to artificially lower the baseline, increasing "surplus" and treasury cut.
- **Impact:** No economic damage to protocol or other users, but is a UX footgun where off-chain integration error could cause users to massively overpay treasury.
- **Recommended fix:** Remove `direct_pool` from signature. Change to `metadata_out: Object<Metadata>` and use `canonical_pool_address_of` internally.

### INFORMATIONAL-1: Post-Execution Sanity Checks
- **Location:** `arbitrage.move` (close_triangle_compose, close_triangle_flash_compose)
- **Description:** Checking `actual_out >= seed_amount` and `actual_out >= required` after execution is excellent defense-in-depth. Keep them.

---

## OQ answers
- **OQ-1:** Do NOT allow unbounded O(N^K). Add `&mut u64` budget to dfs_path/dfs_cycle. Budget ~150-200. Decrement per iteration. Return early on 0.
- **OQ-2:** Canonicalize. Change `direct_pool` to `metadata_out`. Use `canonical_pool_address_of` internally. Removes footgun, shrinks API.
- **OQ-3:** Keep MAX_HOPS=4/MAX_CYCLE_LEN=5 with shared budget.
- **OQ-4:** Yes, canonicalize `swap_entry` (see OQ-2).
- **OQ-5:** Keep pre-pass. Fail early with `E_WRONG_POOL` is cleaner.
- **OQ-6:** Let callers execute sub-optimal paths. Primitives execute what they're commanded.
- **OQ-7:** Option (c) is correct. Forcing `&signer` destroys composability.

---

## Q1-Q9 answers
All verified sound. Core math, accounting, composability, flash-loan safety "exceptionally robust". Zero-admin architecture "properly implemented".

---

## Overall verdict
**YELLOW** — Fix HIGH-1 (DFS node budget) before mainnet. Protocol's core math, accounting, composability, and flash-loan safety are exceptionally robust. Once DFS budget is implemented, package will be **GREEN**.
