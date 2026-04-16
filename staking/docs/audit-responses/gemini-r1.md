# Gemini 2.5 Pro — LP Staking R1 audit response

**Date:** 2026-04-16
**Verdict:** YELLOW → GREEN after analysis
**Severity counts:** 1 HIGH / 1 MEDIUM / 1 INFORMATIONAL

---

## Findings

### HIGH-1: deposit_rewards lacks update_pool before balance increment — VALID BUT LOW IMPACT

**Location:** staking.move:151-169 (`deposit_rewards`)
**Description:** When a reward pool runs dry and someone deposits new rewards, `update_pool` isn't called first. The next interaction (stake/claim/unstake) will compute `elapsed` from the stale `last_reward_time`, causing the new deposit to retroactively cover the dry period.
**Our analysis:** Gemini is technically correct — the emission "catches up" over the dry period. However:
- During the dry period with `total_staked_shares > 0`: `update_pool` runs, `total_reward = min(elapsed * rate, reward_balance)`. If `reward_balance = 0`, `total_reward = 0`, `last_reward_time` advances. So **no debt accumulates during the dry period** — time advances, just no rewards are distributed.
- The issue only exists if `total_staked_shares == 0` during the dry period: `update_pool` only advances `last_reward_time` without emitting. Then someone stakes, then someone deposits. At the next `update_pool`, elapsed covers the gap. But if nobody was staked during that period, the retroactive emission goes to whoever stakes first.

**Actually:** Re-reading `update_pool` carefully:
```
if (rp.total_staked_shares == 0) {
    rp.last_reward_time = now;
    return
}
```
When `total_staked_shares == 0`, `last_reward_time` IS advanced to `now`. No gap accumulates. When `total_staked_shares > 0` but `reward_balance == 0`, `total_reward = 0` and `last_reward_time` advances. **No retroactive drainage in either case.**

**Verdict: NOT EXPLOITABLE.** The `update_pool` logic already handles both dry scenarios correctly. Adding `update_pool` to `deposit_rewards` is harmless but unnecessary.

### MEDIUM-1: FOT reward tokens could cause insolvency — ACKNOWLEDGED (edge case)

**Location:** staking.move:160-163 (`deposit_rewards`)
**Description:** If reward token has fee-on-transfer, actual deposited amount < recorded `reward_balance`.
**Our analysis:** Valid edge case. However:
- Aptos native FA tokens do NOT have FOT by default
- Custom dispatchable FA with transfer hooks is extremely rare on Aptos
- The token vault has the same pattern (no delta check) and was audited GREEN by 4/5 auditors
- Adding balance-before/after check adds gas and complexity for a near-zero probability scenario

**Verdict: ACKNOWLEDGED.** Not fixing — consistent with token vault design. If Darbitex ever supports dispatchable FA with hooks, both vault and staking would need the same fix.

### INFORMATIONAL-1: Token return order assumption

Core `claim_lp_fees` returns `(fa_a, fa_b)` matching `pool_tokens` order — both use `pool.metadata_a` / `pool.metadata_b` in the same order. Deterministic. No issue.

---

## Design decisions validated

All 6 (D-1..D-6) confirmed correct.
