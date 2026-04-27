# R1 Audit — Consolidated Findings

**Bundle:** `darbitex_lp_locker` + `darbitex_staking` (Aptos redeploy)
**Submission:** `AUDIT-R1-SUBMISSION.md` (2026-04-27)
**Panel:** 6 LLM auditors — Claude 4.7, Gemini 2.5 Pro, Kimi K2, DeepSeek V3, Qwen, Grok 4
**Tests:** 34/34 PASS at submission time
**No fixes applied yet** — pending user discussion per `feedback_auditor_rec_signoff`

---

## Verdict roll-up

| Auditor | Verdict | HIGH | MED | LOW | INFO |
|---|---|---|---|---|---|
| Claude 4.7 | ✅ GREEN | 0 | 1 | 1 | 5 |
| Gemini 2.5 Pro | ✅ GREEN | 0 | 0 | 0 | 4 |
| Kimi K2 | ✅ GREEN | 0 | 0 | 0 | 3 |
| DeepSeek V3 | ✅ GREEN | 0 | 0 | 0 | 3 |
| Grok 4 | ✅ GREEN (with caveats) | 0 | 2 | 2 | 3 |
| Qwen | ⚠ YELLOW | 1 | 1 | 1 | 2 |

**Consensus:** 5/6 GREEN, 1/6 YELLOW. Zero unanimous severity findings.

---

## Cross-auditor consensus matrix

Each row is a distinct issue; columns are how each auditor classified it.
**`—` = not raised by that auditor.** **bold** = consensus convergence.

| # | Issue | Claude | Gemini | Kimi | DeepSeek | Grok | Qwen |
|---|---|---|---|---|---|---|---|
| **C1** | `move_from` before validation in `redeem_position` + `unstake_*` (Move VM rollback semantics) | INFO-1 (cosmetic) | INFO-1 (no fix) | — | INFO-3 (no fix) | LOW-1 (hygiene) | **HIGH-1** (must fix) |
| **C2** | Pool match via metadata, not pool address (coupling to core canonical-pair invariant) | **MED-1** (recommend fix) | — | — | — | — | — |
| **C3** | `committed_rewards` underflow under interleaved updates (extra invariant assert recommended) | — | — | — | — | MED-1 (recommend fix) | — |
| **C4** | Timestamp / MEV / front-running risk on lock & rewards | — | — | — | — | MED-2 (optional) | — |
| **C5** | `acc_at_stake` updated before withdraw (CEI ordering) | — | — | — | — | LOW-2 (CEI hygiene) | MED-1 (CEI hygiene) |
| **C6** | `claim_lp_fees` does not call `update_pool` (view-layer staleness) | — | — | — | — | — | LOW-1 (doc only) |
| **C7** | Reward pool dust accumulation in `committed_rewards` | INFO-2 | — | INFO-2 | — | — | — |
| **C8** | u128 `acc_reward_per_share` overflow → DoS (not silent corruption) | INFO-3 (reframe WARNING) | — | — | INFO-2 (already accepted) | — | — |
| **C9** | `claim_rewards` aborts on `pending == 0` after running `update_pool` (gas wasted) | INFO-4 | — | — | — | — | — |
| **C10** | `LpStakePosition` ungated transferability not disclosed in WARNING | INFO-5 | — | — | — | — | — |
| **C11** | `LpRewardPool` lacks `delete_ref` (permanent storage occupation) | — | — | INFO-3 | INFO-1 | — | INFO-2 |
| **C12** | Zero-value FA deposit handling relies on framework v1.5+ behavior | — | INFO-2 (no fix) | — | — | — | — |
| **C13** | Stake-signer authorization correctness (Area 2+4 verification) | ✓ verified | INFO-3 (✓ verified) | — | — | — | — |
| **C14** | Clock-stalling guarantee on `bump==0` (B7) verification | — | INFO-4 (✓ verified) | — | — | — | — |
| **C15** | Reward-pool address omitted from claim events | — | — | INFO-1 | — | — | — |
| **C16** | `claim_fees_assets` requires explicit downstream FA handling | — | — | — | — | — | INFO-1 (doc) |
| **C17** | Event completeness (update_pool internal events) | — | — | — | — | INFO-1 | — |
| **C18** | `#[view]` annotation consistency across views | — | — | — | — | INFO-2 (✓ check) | — |
| **C19** | WARNING drift prevention test mechanism | — | — | — | — | INFO-3 (keep) | — |

---

## Disputed findings (multiple auditors, divergent conclusions)

### C1 — `move_from` before validation

The single most-flagged code site. **6/6 auditors visited it; classifications diverge:**

- **Qwen (HIGH):** "abort-safety violation. ExtendRef/DeleteRef don't have `drop`, so destructured fields cause compiler error or runtime undefined behavior."
- **Gemini, DeepSeek, Claude (INFO/safe):** "Move VM transactional rollback discards the entire write set on `abort`. The `move_from` itself is reverted. `abort: !` (bottom type) doesn't require destructured fields to be consumed. No leak, no orphan."
- **Grok (LOW hygiene):** "Tests pass; no observed leak. Consider refactoring for hygiene + future Move runtime robustness."

**Ground-truth check:** the redeploy's existing test `unstake_naked_on_locked_aborts` exercises this exact code path and passes (`E_NOT_NAKED=6`). Compile passes Aptos CLI 9.1.0. Move 2 abort semantics are well-defined: `abort` is a divergent expression of type `!`, transaction-level rollback restores all global state, and destructured locals in scope at abort time don't need to satisfy linear-types invariants because the transaction never commits. **Qwen's HIGH-1 appears to be a misreading** of Move 2 abort + transactional rollback semantics. Three peers (Claude, Gemini, DeepSeek) explicitly verified and rejected it. Grok's LOW-1 is hygiene-only ("future-proof against runtime changes").

**Recommendation status:** open for discussion. Likely classification = INFO (hygiene) or no-action. Pre-applying a refactor (validate-before-move_from) would be defensive but is not safety-required.

### C5 — `acc_at_stake` updated before withdraw (CEI ordering)

Two auditors flag, neither calls it a security issue:
- **Qwen MED-1:** "anti-pattern; framework changes could open inconsistency window."
- **Grok LOW-2:** "follow CEI more visibly; mostly already followed."

Both acknowledge Aptos transactional atomicity makes this safe today. **Tier-2 stylistic** per `feedback_auditor_rec_signoff`.

---

## Unique findings (single-auditor)

### Claude MED-1 (C2) — Pool match via metadata, not pool address

The only auditor to dig into the §1 question 3 attack path with a concrete forward-compat scenario. Argues:
- Metadata-equality check passes iff `pool_factory` enforces canonical-pair invariant
- LP positions carry `pool_addr` field in core but no view exposes it
- If a future core upgrade introduces fee tiers / variants / regression, attack becomes:
  - stake position from pool A into reward pool bound to pool B
  - emission rate becomes `(S_A / L_B) × max_rate_per_sec` — can exceed documented ceiling
- Free-balance cap still bounds total drain, but rate ceiling is bypassable
- Fix: add `position_pool_addr` core view + tighten satellite check, OR contractually freeze invariant in WARNING

**Ground-truth check:** Today's `pool_factory::create_canonical_pool` enforces the invariant. So this is genuinely "future-proof against core regression" rather than current-vulnerability. Submission §6 LOW-S1 already self-flagged this as out-of-scope. Claude's MED-1 elevates the visibility but doesn't claim current exploitability.

**Recommendation status:** open for discussion. Two paths:
- (a) Apply Claude's recommendation: add `position_pool_addr` core view (one-line compat upgrade) + hoist check in staking. Cost: one additional core multisig upgrade in this deploy cycle.
- (b) Document the core-coupling explicitly in staking WARNING, accept as "satellite is implicitly coupled to core canonical-pair invariant."
- (c) Both.

### Grok MED-1 (C3) — `committed_rewards` underflow defensive assert

Recommends `assert!(rp.committed_rewards >= pending, E_OVERCOMMIT)` before subtraction in `claim_rewards`/`unstake_*`. Argues subtle interleaved-call race could violate invariant. No exploit demonstrated; "defensive hardening."

**Ground-truth check:** Claude's verification §1 in their response proves the invariant `Σ pending ≤ committed` holds inductively from update_pool's per_share_bump floor div. Move u64 subtraction aborts on underflow natively, so adding an explicit assert is redundant runtime check + clearer error code.

**Recommendation status:** open for discussion. Tier-2 (defensive).

### Grok MED-2 (C4) — Timestamp / MEV

Generic Aptos timestamp warning. No concrete exploit. Suggests minimum-lock-duration buffer.

**Recommendation status:** Tier-2 policy. Mostly redundant with WARNING item 2 (CLOCK SOURCE).

### Claude INFO-3 (C8) — u128 overflow failure mode reframe

Worthwhile WARNING text update: clarify that overflow → permanent emission halt + stake lockout (principal lock-out, not just reward loss). Mirror Sui R3+R4 disclosure precision.

### Claude INFO-5 (C10) — `LpStakePosition` transferability disclosure

Recommends adding "STAKE WRAPPER TRANSFERABILITY" item to staking WARNING. Currently the WARNING has 14 items; locker WARNING item 3 covers wrapper transferability for `LockedPosition` but staking WARNING does not have an equivalent item for `LpStakePosition`.

**Ground-truth check:** Reading the source — the staking WARNING (`staking.move:51`) doesn't contain a "STAKE WRAPPER TRANSFERABILITY" item. Stake objects ARE transferable (created via `object::create_object` with default ungated transfer). Frontend / users may assume principal-bound. Claude's INFO-5 is a real disclosure gap.

**Recommendation status:** Tier-2 disclosure. Worth applying.

### Kimi INFO-1 (C15) — Reward-pool address in claim events

Adds `reward_pool_addr` to `LpRewardsClaimed` and `LpFeesClaimed` for indexer ergonomics. Pure UX/indexer improvement.

**Recommendation status:** Tier-2 nice-to-have.

### C11 — `LpRewardPool` permanent storage (no delete_ref)

Three auditors flagged (Kimi INFO-3, DeepSeek INFO-1, Qwen INFO-2). All three classify as INFO/non-issue, aligning with the explicit §11 design accept "permissionless creation makes retirement a non-goal." No action needed.

### C7, C13, C14 — Verifications, not findings

These are auditor confirmations of submission claims (B7 dust guard works, stake signer auth correct, dust accumulation bounded). No action.

---

## Severity by classification (post-cross-check)

After cross-auditor verification, my proposed re-classification (open to user override):

| Original | Auditor | Cross-check verdict | Suggested action |
|---|---|---|---|
| HIGH-1 (Qwen) | C1 | **Misread of Move 2 abort semantics.** 3 peer auditors verified safe. | Reject as finding. Optionally apply Grok LOW-1 hygiene refactor (Tier-2). |
| MED-1 (Claude) | C2 | Real future-coupling concern. Today safe. | **REJECTED by user 2026-04-27** — Darbitex `pool_factory` canonical-pair invariant is by-design contract. Satellite coupling is intentional. No code change, no WARNING update. |
| MED-1 (Grok) | C3 | Redundant defensive assert. Move u64 underflow already aborts natively. | Discuss — Tier-2 defensive. |
| MED-2 (Grok) | C4 | Generic timestamp warning. No concrete exploit. | Reject as finding. Already covered by WARNING item 2. |
| MED-1 (Qwen) / LOW-2 (Grok) | C5 | CEI ordering hygiene. Atomicity makes safe today. | Discuss — Tier-2 stylistic. |
| LOW-1 (Qwen) | C6 | Pure documentation request. | Apply trivially as docstring comment. |
| LOW-1 (Grok) | C1 hygiene | Same site as C1; hygiene only. | See C1. |
| INFO-3 (Claude) | C8 | WARNING text precision improvement. | Apply trivially as WARNING text update. |
| INFO-5 (Claude) | C10 | Real disclosure gap (stake wrapper transferability). | Apply: add WARNING item, byte-anchor in test. |
| INFO-1 (Kimi) | C15 | Indexer UX improvement. | Tier-2 nice-to-have. |
| All other INFO | C7, C9, C11, C12, C13, C14, C16, C17, C18, C19 | No action / already accepted / verifications. | None. |

---

## Summary for discussion

**Zero HIGH after cross-check.** Qwen HIGH-1 is a Move 2 semantics misread (3 peer auditors verified safe).

**Open MED status:**
- **Claude C2 (pool match coupling):** REJECTED by user 2026-04-27. Canonical-pair invariant is contractual. Move on.
- **Grok C3 (defensive assert):** redundant given Move u64 underflow native abort. Decision: probably reject, or Tier-2 hardening. Pending user.

**Pre-immutable-soak action items if all light fixes applied:**
1. WARNING text: reframe u128 overflow as principal-lockout (Claude INFO-3) — single sentence
2. WARNING text: add STAKE WRAPPER TRANSFERABILITY item (Claude INFO-5)
3. WARNING text: document `claim_lp_fees` no-update_pool semantic (Qwen LOW-1) — single sentence comment
4. Events: add `reward_pool_addr` to LpRewardsClaimed + LpFeesClaimed (Kimi INFO-1) — Tier-2
5. Optionally: refactor `move_from`-before-validation for hygiene (Grok LOW-1) — Tier-2
6. Discuss Claude MED-1 separately

**Per `feedback_auditor_rec_signoff`:** all of the above are Tier-2 (none are safety-critical). User signoff required before applying any.

**R1 verdict:** GREEN with proposed Tier-2 patch batch. R2 round not required unless user wants confirmation of patch correctness.
