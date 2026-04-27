# DEPRECATED — see `../staking-redeploy/`

**Status:** v1 superseded 2026-04-27.
**Do not use the address in this folder for new work.**

## Canonical replacement

| | v1 (this folder) | redeploy |
|---|---|---|
| Aptos mainnet address | `0xeec9f2361d1ae5e3ce5884523ad5d7bce6948d6ca12496bf0d8b8a6cbebaa050` | `0xb6ca26fade34212464f475f95ef49257d3f7c4e22907a622c94d319a2648f714` |
| Module | `darbitex_staking::staking` | `darbitex_staking::staking` |
| Source on disk | `staking/` | `staking-redeploy/` |
| Upgrade authority | 3/5 multisig (live, soakable) | 6/6 multisig with `0xdead` unsignable owner — quorum unreachable, effectively immutable |
| Emission formula | variant A: `min(staked, target) × max_rate / target` (creator-set `stake_target`) | variant C: `staked × max_rate_per_sec / pool::lp_supply` (pool-derived denominator) |
| `stake_target: u64` field | exists | dropped (auto-derived from canonical pool) |
| `reward_balance: u64` counter | exists | dropped (use `primary_fungible_store::balance`) |
| `committed_rewards: u64` field | absent | added (caps `update_pool` at free balance — closes B3 over-credit class) |
| `reward_debt: u128` field | exists (pre-multiplied) | replaced by `acc_at_stake: u128` snapshot (avoids u128 overflow on large products) |
| Locked LP staking | not supported | `stake_locked_lp` accepts `Object<LockedPosition>` from lp-locker (3-firewall composition) |
| Typed unstake | single `unstake_lp` | `unstake_naked` / `unstake_locked` with `E_NOT_NAKED=6` / `E_NOT_LOCKED=7` aborts |
| `CREATION_FEE` (1 APT) | charged on `create_lp_reward_pool` and `stake_lp` | dropped |
| WARNING constant | absent | 16-item on-chain disclosure + `read_warning()` `#[view]` |
| u256 in pending math | absent | yes (kills u128 overflow class) |
| Ceiling division on `accounted_seconds` | floor (truncates clock advance) | ceiling (kills `accounted_ms=0` re-emission class) |
| Dust guard `paid==0` early-return | unconditional clock advance | early-return (kills dust-spam grief) |
| Dust guard `per_share_bump==0` early-return | absent | added |

## Why deprecated — 8 latent bugs from Sui R3+R4 audit

Aptos v1 was carrying 4 of 8 distinct bugs that the Sui port surfaced through 4 audit rounds (R1..R4). The most serious was B3 over-credit re-emission (Claude HIGH-1 in Sui R2): with the v1 cap-at-physical-balance pattern, repeated `update_pool` calls could re-emit against committed-but-unclaimed coins, eventually making pending > balance and locking claim/unstake permanently. Only some indirect mitigation in Aptos v1 (the `reward_balance: u64` counter accidentally captured "free" semantics) prevented the bug from being live, but the reasoning was fragile.

Other bugs pre-empted in redeploy:
- B1 dust-spam clock advance (Gemini Sui R1 MED-1) — Aptos v1 was vulnerable
- B4 u128 overflow in `(shares × acc) / SCALE` (Claude/Kimi Sui R2 MED) — Aptos v1 was vulnerable
- B7 dust leak when `per_share_bump = 0` (Claude Sui R3 INFO-1) — Aptos v1 was partially mitigated

Adding the 8 fixes to v1 in place was not possible under Aptos `compatible` upgrade policy because several involve struct-layout breakages (rename `reward_debt → acc_at_stake`, drop `stake_target` and `reward_balance`, add `committed_rewards`, replace `position` field with `inner: StakedLp` enum).

## What v1 does

The v1 module is still live on chain at `0xeec9f2361d1ae...` and remains functionally usable for naked LP staking on the original variant-A formula. Existing stakers there can still:
- `claim_rewards` — works
- `claim_lp_fees` — works
- `unstake_lp` — works

There is no migration path. Existing stakers should `unstake_lp` from v1 and re-stake in the redeploy under the new variant-C formula. New users should go directly to the redeploy.

The v1 module never had the DARBITEX/APT pool reward stream activated in production (per `darbitex_lp_staking_vision.md`: "DARBITEX tokenomics pending"), so user impact of deprecation is limited.

## Audit history (v1)

`docs/AUDIT-STAKING-SUBMISSION.md` + `docs/audit-responses/` — kept for transparency. v1 was 5/5 R1 GREEN at the time, but auditors did not have access to the Sui R3+R4 findings.

## Resume

For new staking work: `staking-redeploy/` and `tag lp-redeploy-v0.1.0`.
For redeploy live state: `staking-redeploy/DEPLOYMENT.md`.
