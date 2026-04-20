---
name: Darbitex North Star — fully autonomous on-chain
description: Core architectural commitment. Every design decision must preserve the contract's ability to make decisions without off-chain input. Off-chain allowed for trigger + observation only, never for judgment injection.
type: feedback
originSessionId: b723ec02-3298-4fac-9e6b-5a63ad6992b5
---
**North Star**: Darbitex arb engine (omni-router, TWAMM triggers, any future MEV satellites) is **fully autonomous on-chain**. All economic and routing decisions must live in Move code on Aptos. Off-chain infrastructure exists only to (a) trigger execution and (b) enable third-party integration — never to make decisions that the contract trusts.

**Why**: Credible-neutrality, resilience, and composability. Any contract that depends on an off-chain oracle/router/decision-maker is not actually autonomous — it is a centralized bot wearing Move clothing. Real autonomy means anyone can `aptos move run` the entry function and the contract alone decides whether to execute or revert.

## How to apply

**✅ Allowed off-chain**:
- Trigger optimization: keeper bots polling for TWAMM orders to tick, arb scanners detecting opportunities, cron jobs calling entry functions. Trigger = "wake up the contract". Contract still makes the full decision.
- Third-party integrations: UIs, aggregator APIs, other people's bots that want to integrate with Darbitex. Their off-chain logic is their problem. As long as our contract stands alone, integrators can build whatever.
- Observability: indexers, Walrus-hosted frontends, event log consumers.

**❌ Forbidden — violates north star**:
- Passing pre-computed routes or venue hints from keeper → contract trusts the hint. **No venue hints.** Contract must iterate venues itself and pick.
- Off-chain quote aggregation where contract accepts the "best" and executes blindly.
- Off-chain size calculations (optimal borrow) passed as arg. Contract must compute itself (like `calculate_optimal_borrow` already does).
- Off-chain oracle feeds where contract consumes a signed price from a bot.

**Litmus test**: if the off-chain dependency disappears (bot killed, server down, dev rug), can the contract still execute correctly against a naive `aptos move run` call? If no → violates north star.

## Implications for V2 omni-router work

The only viable architecture for multi-venue dispatcher:
- Contract receives minimal params (or zero params — purely keeper-triggered)
- Contract iterates N venues on-chain via view calls / compute
- Contract picks best venue via `calculate_optimal_borrow` per venue
- Contract executes atomic, reverts on loss

Gas concern about on-chain quote comparison across venues is **acceptable** because:
1. Revert-on-loss means cost of wrong guess = only gas
2. Keeper can speculate frequently without capital risk
3. Aptos gas is cheap at current pricing — not bottleneck

**Never implement**: keeper-side route optimization passed as venue hint to contract. If tempted, re-read this memo.

## Applied 2026-04-20

Post-TWAMM-v0.1.1 mainnet deploy, user clarified that any "Step 2" involving "keeper off-chain compute + pass venue hint" is rejected outright. North star locked.

V2 Candidate J (multi-venue restore) must implement **on-chain venue iteration**, not off-chain hints. Updated `darbitex_twamm_v2_candidates.md` accordingly.
