# Kimi K2 — Token Factory R1 audit response

**Date:** 2026-04-16
**Verdict:** 🟢 **GREEN — well-designed and secure for mainnet deployment**
**Severity counts:** 0 HIGH / 0 MEDIUM / 2 LOW (input validation/UX) / 3 INFO

Note: Kimi initially labeled 2 findings as HIGH-1 and MEDIUM-1/MEDIUM-2 but self-downgraded all three during analysis — HIGH-1 downgraded to "not a HIGH issue" (atomic rollback confirmed), MEDIUM-1 downgraded to LOW ("design is correct"), MEDIUM-2 is a UX limitation not a security issue (burn only from primary store). Adjusted counts reflect final assessed severity.

---

## Findings

### LOW-1: No validation on symbol format (phishing risk, not security)
- No max length, no character validation, case-sensitive ("TEST" vs "test" are different symbols)
- Recommend: alphanumeric only, max length check

### LOW-2: Treasury address hardcoded but not validated at deploy time
- Deployment risk, not runtime risk
- Recommend: verify address before mainnet deploy

### INFORMATIONAL-1: Event emission order — correct, no issue
### INFORMATIONAL-2: No upgrade path for fee structure — by design (fire-and-forget)
### INFORMATIONAL-3: Symbol squatting risk for 5+ char symbols at 0.1 APT — economic design choice

## Self-downgraded findings (not actionable)

- **HIGH-1 (self-downgraded):** Fee before creation ordering → confirmed atomic rollback protects, not a real issue
- **MEDIUM-1 (self-downgraded):** Max supply cap + MintRef → confirmed MintRef drop is the actual control, design correct
- **MEDIUM-2 (UX note):** Burn only from primary store → intentional, document the behavior

## Design questions — all 5 confirmed

- D-1 MintRef drop: **VERIFIED SAFE** (ConstructorRef ephemeral)
- D-2 BurnCap isolation: **VERIFIED SAFE** (module-private, no extraction)
- D-3 Fee refund on abort: **VERIFIED SAFE** (atomic rollback)
- D-4 Tiered pricing: **VERIFIED SAFE** (all cases covered, no gaps)
- D-5 No token count: **ACCEPTABLE**

## Threat model — all 8 vectors ✅ MITIGATED

## Verdict: 🟢 GREEN
