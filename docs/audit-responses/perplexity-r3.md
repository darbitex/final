# Perplexity R3 — Darbitex Final

**Auditor:** Perplexity Sonnet Pro (fresh web session, reasoning mode)
**Code reviewed:** R2.2 submission (AUDIT-FINAL-PACKAGE.md)
**Verdict:** 🟢 GREEN (mainnet publish ready)

---

## Findings

### HIGH: none
> "I did not find a blocking vulnerability in the audited pool, factory, or arbitrage flow from the material provided. The main security controls that matter here—canonical pool derivation, locked flash-borrow state, hot-potato receipt consumption, and the FA linearity model—are implemented in a way that is internally consistent with the design goals described in the package."

### MEDIUM-1: DFS gas scaling tradeoff (operational risk, not correctness bug)
- **Location:** `swap_compose` and `execute_path_compose` DFS/path simulation
- **Description:** Even after lazy pagination fix, gas scales with pool count per asset. Mature assets with many pools → expensive worst-case routing.
- **Status:** Not a correctness bug. Operational risk. Matches Gemini R2 MEDIUM-1 and the documented OQ-1 tradeoff.

### MEDIUM-2: `pools_containing_asset` + lazy DFS pagination — earlier DoS shape closed
- **Location:** `pool_factory::pools_containing_asset` + arbitrage module DFS walks
- **Description:** "Returns a paginated bucket with a hard cap of 10 per read, and the arbitrage module now walks pages lazily instead of bulk-loading them. **That closes the earlier DoS shape**, but it still means router performance is tightly coupled to ecosystem growth and DFS budget settings."
- **Status:** **Perplexity explicitly confirms Gemini R2 HIGH-1 fix (lazy pagination) closes the DoS vector.** Residual performance coupling is accepted tradeoff.

### LOW-1: Event attribution spoofable
- Documented tradeoff (OQ-7). Confirmed acceptable. "Economically it does not let an attacker steal funds, but indexers should not treat those fields as authoritative identity."

### LOW-2: Treasury cut rounds down via integer division
- Intentional. Favors callers on odd-value surplus amounts. Low risk.

### INFORMATIONAL

1. **Three-layer architecture praised:** "Cleanly structured around three layers: entry wrappers, FA-in/FA-out compose functions, and view helpers for quote discovery. That is a good design choice for Aptos Move because it preserves composability without exposing signer-based authorization where it is not needed."
2. **Hot-potato FlashReceipt praised:** "Right pattern for preventing partial-use of borrowed capital."
3. **Canonical pool uniqueness praised:** "Removes caller-nominated baseline ambiguity and avoids duplicate-pool confusion in routing."

---

## Design questions answered

1. **Gas ceiling for DFS:** `DFS_VISIT_BUDGET = 256` + `MAX_HOPS = 4` + `MAX_CYCLE_LEN = 5` is "a reasonable launch posture, but it is still a soft bound rather than a strict economic one." Policy decision for ecosystem maturity.
2. **Service-charge UX:** "The '10% of surplus over baseline' rule is coherent and consistently applied, **including the no-direct-pool case where baseline is zero and no cut is taken**. That is philosophically clean." — **Perplexity explicitly confirms Claude R2 HIGH-1 fix (zero-baseline guard).**
3. **Event trust model:** Acceptable as advisory metadata only.

---

## Verified R2 hotfixes

Perplexity explicitly confirmed in its narrative that BOTH R2 HIGH fixes correctly address their respective issues:

- ✅ **R2.1 (Claude HIGH-1 / zero-baseline guard):** "service charge is based on measured surplus rather than arbitrary caller input... including the no-direct-pool case where baseline is zero and no cut is taken."
- ✅ **R2.2 (Gemini HIGH-1 / lazy pagination):** "arbitrage module now walks pages lazily instead of bulk-loading them. That closes the earlier DoS shape."

This is the first auditor in R3 to explicitly verify both R2 hotfixes.

---

## Overall verdict
**🟢 GREEN for mainnet publish readiness**

Strongest parts of the design per Perplexity:
1. Canonical pool address model
2. Flash-repay receipt discipline
3. Service charge based on measured surplus rather than arbitrary caller input

Accepted tradeoffs:
- DFS gas growth with ecosystem (documented, OQ-1)
- Event attribution spoofability (documented, OQ-7)
