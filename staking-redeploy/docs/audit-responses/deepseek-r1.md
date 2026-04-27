# DeepSeek V3 — R1 Audit Response

**Received:** 2026-04-27
**Verdict:** GREEN
**Findings:** 0 HIGH / 0 MED / 0 LOW / 3 INFO (all "no fix required" or design-accept)

---

## Findings

### INFORMATIONAL-1: Reward pool objects are permanently undeletable
Module: staking  
Location: `staking.move:~120` (create_reward_pool)  
Description: The `LpRewardPool` object is created without a `DeleteRef`. The module never implements a function to delete it. Once a reward pool becomes obsolete (e.g., reward token fully drained, pool deprecated), its on-chain storage persists forever.  
Impact: Extremely minor storage bloat; no funds are at risk and no user can be harmed.  
Recommended fix: If future cleanliness is desired, store a `DeleteRef` inside `LpRewardPool` (similar to `LpStakePosition`) and expose an admin‑guarded `delete_lp_reward_pool` entry function, but this is purely cosmetic.

### INFORMATIONAL-2: `acc_reward_per_share` theoretical overflow (already documented)
Module: staking  
Location: `staking.move:~500` (update_pool)  
Description: The `acc_reward_per_share: u128` accumulator could, in a theoretical extreme with `max_rate_per_sec = u64::MAX`, `staked = 1`, and ≈1.8×10⁷ `update_pool` calls, overflow u128 (max ~3.4×10³⁸).  
Impact: No practical risk under realistic parameters; the design accept from the Sui audit (R3+R4) has been ported here.  
Recommended fix: None (accepted by the team).

### INFORMATIONAL-3: `move_from` before variant check in `unstake_*` is safe but warrants note
Module: staking  
Location: `staking.move:376-382` (unstake_naked), `staking.move:419-426` (unstake_locked)  
Description: Both functions destructure the `LpStakePosition` via `move_from` before checking the enum variant. If the wrong variant is supplied, the transaction aborts with `E_NOT_NAKED`/`E_NOT_LOCKED`. Because Move's transactional semantics roll back all state changes on abort, the `LpStakePosition` resource is not lost; the abort simply leaves the resource in storage.  
Impact: No resource leakage; the code is correct.  
Recommended fix: None, but the pattern is safe and no change is needed.

---

## Overall verdict
**GREEN** — the locker and staking packages are ready for mainnet publish.  
The design correctly enforces all stated security goals: authorization is sound, funds are protected, cross‑pool staking is blocked, the MasterChef accumulator math is robust (with the eight ported fixes), and the three‑firewall composition for locked‑staked LP guarantees that the inner `LpPosition` can never leave the locker before its unlock time. No high‑ or medium‑severity issues were found.
