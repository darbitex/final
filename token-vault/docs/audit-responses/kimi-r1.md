# Kimi (Moonshot) — Token Vault R1 audit response

**Date:** 2026-04-16
**Verdict:** 🟡 **YELLOW** → GREEN after analysis
**Severity counts:** 1 HIGH (self-corrected to non-issue) / 3 MEDIUM (all self-corrected) / 3 LOW / 3 INFORMATIONAL

---

## Findings

### HIGH-1: Underflow in `claim_vested` when `vested_available < claimed_amount` — FALSE POSITIVE

**Location:** vault.move:286-287
**Description:** Auditor claims `vested_available(v) - v.claimed_amount` could underflow if `vested_available` returns less than `claimed_amount`.
**Our analysis:** **Cannot happen.** `vested_available` is monotonically non-decreasing (it depends only on `now` which only moves forward). Once `claimed_amount` is set to `vested_available(v)` at claim time (line 289: `v.claimed_amount = v.claimed_amount + claimable`), any future call will have `vested_available(v) >= v.claimed_amount` because:
- `vested_available` can only increase or stay the same as time advances
- `claimed_amount` only increases by `claimable = vested_available - claimed_amount`
- After update: `claimed_amount = vested_available` at that moment
- Next call: `vested_available(now2) >= vested_available(now1) = claimed_amount`

The auditor's "clock manipulation" concern is invalid — Aptos validators cannot move `timestamp::now_seconds()` backwards. The "rounding" concern is also invalid — `vested_available` uses floor division which is deterministic and non-decreasing with time.

### MEDIUM-1: Same-token pool double-withdrawal risk — SELF-CORRECTED to INFORMATIONAL

Auditor initially flagged, then analyzed the math and concluded it's safe. Invariant `FA store = total_staked + reward_balance` holds.

### MEDIUM-2: `stake_pending_reward` view discrepancy — SELF-CORRECTED to NO BUG

Auditor analyzed and found the view correctly simulates pool update with reward_balance cap.

### MEDIUM-3: Integer overflow in emission calculations — ACKNOWLEDGED (same as DeepSeek HIGH-1)

`elapsed * rate` could overflow u128 for extreme parameters. Same theoretical risk. Economically unreachable with real pools.

### LOW-1: Division by zero in `vested_available` — SELF-CORRECTED

Protected by `create_vesting` assertion `end_time > start_time`.

### LOW-2: Event emission after state mutation — SELF-CORRECTED

Move transactions are atomic. Abort reverts everything.

### LOW-3: No upper bound on `unlock_at` — ACKNOWLEDGED

Same as Internal Auditor 4 MAJOR-3 and DeepSeek. User's choice.

### INFORMATIONAL-1: Reward pool immortality — by design
### INFORMATIONAL-2: Hardcoded treasury address — changeable via compat upgrade
### INFORMATIONAL-3: Dust stake dilution — 1 APT fee deters, standard MasterChef behavior

---

## Notable self-corrections by auditor

Kimi initially raised 1 HIGH + 3 MEDIUM but self-corrected 3 of them during analysis:
- HIGH-2 (deposit_rewards no owner check): retracted — permissionless by design
- MEDIUM-1 (same-token withdrawal): retracted — math holds
- MEDIUM-2 (view discrepancy): retracted — no bug found

The remaining HIGH-1 (vested_available underflow) is a false positive due to incorrect assumption about clock manipulation on Aptos.
