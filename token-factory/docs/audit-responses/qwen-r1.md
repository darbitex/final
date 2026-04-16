# Qwen — Token Factory R1 audit response

**Date:** 2026-04-16
**Verdict:** 🟢 **GREEN — safe for mainnet deployment**
**Severity counts:** 0 HIGH / 0 MEDIUM / 2 LOW (gas/UX nits) / 2 INFO (non-blocking)

---

## Findings

### LOW-1: Missing explicit UTF-8 validation for name/symbol (UX — framework abort code vs custom error)
### LOW-2: No max length check on symbol (gas waste before framework abort)
### INFORMATIONAL-1: Zero-amount burn permitted (gas nit)
### INFORMATIONAL-2: Event construction post-state-mutation (gas optimization awareness)

## Design questions — all 5 confirmed

- D-1 MintRef drop: **provably permanent** (ConstructorRef transient, drop-only)
- D-2 BurnCap isolation: **confirmed sound** (module-private, withdraw enforces holder-only)
- D-3 Fee refund on abort: **confirmed** (atomic rollback)
- D-4 Tiered pricing: **sound and deterministic** (pure constants, no overflow)
- D-5 No token count: **confirmed acceptable** (event + deterministic address = standard pattern)

## Verdict: 🟢 GREEN
