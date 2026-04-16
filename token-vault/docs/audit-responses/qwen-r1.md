# Qwen — Token Vault R1 audit response

**Date:** 2026-04-16
**Verdict:** 🟡 **YELLOW** → GREEN after HIGH-1 resolution
**Severity counts:** 1 HIGH / 1 MEDIUM / 1 LOW / 1 INFORMATIONAL

---

## Findings

### HIGH-1: Borrow checker violation in `claim_vested` — FALSE POSITIVE

**Location:** vault.move (`claim_vested` function)
**Description:** Auditor claims `borrow_global_mut` followed by `move_from` in the `remaining == 0` branch will trigger compile-time error `E0403`.
**Auditor's assessment:** Module cannot be compiled or deployed.
**Our response:** **FALSE POSITIVE.** Move uses Non-Lexical Lifetimes (NLL). The mutable reference `v` is last used at line 295 (`let remaining = v.total_amount - v.claimed_amount`). By line 305 (`move_from`), the borrow is dead. The compiler accepts this — verified by:
- `aptos move compile --dev` → zero errors, zero warnings
- `aptos move test` → 24/24 pass
- Testnet deploy + upgrade + freeze to immutable → all successful
- Gemini R1 INFORMATIONAL-3 independently validated: "Move NLL correctly drops the mutable reference `v` before `move_from`. No dangling references."

### MEDIUM-1: `deposit_rewards` skips accumulator sync — ACKNOWLEDGED

**Location:** vault.move (`deposit_rewards`)
**Description:** Depositing rewards doesn't call `update_reward_pool`. View functions may show stale pending rewards until next pool interaction.
**Our response:** By design. Gas-efficient and functionally equivalent to syncing first (Gemini R1 INFORMATIONAL-2 independently confirmed). Frontend documentation responsibility.

### LOW-1: Premature `move_from` in `redeem_locked` — ACKNOWLEDGED

**Location:** vault.move (`redeem_locked`)
**Description:** Destructure via `move_from` happens before time assertion. Wastes gas on failed early redeems.
**Our response:** Acknowledged as minor gas inefficiency. Move's atomic rollback guarantees correctness. Not worth restructuring — keeps code linear.

### INFORMATIONAL-1: Vesting rounding dust correctly handled

Standard integer truncation. Full amount returned at `now >= end_time`. No permanent loss.

---

## Design decision validations

| Decision | Verdict |
|----------|---------|
| D-1: reward_balance at allocation time | ✅ Correct |
| D-2: 1 APT fee per stake | ✅ Acceptable |
| D-3: Permissionless no-admin pools | ✅ Safe |
| D-4: Same-token pools | ✅ Safe |
| D-5: No minimum stake/duration | ⚠️ Acceptable (frontend enforces) |
| D-6: Transferable positions | ✅ Safe |
