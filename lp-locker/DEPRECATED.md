# DEPRECATED — see `../lp-locker-redeploy/`

**Status:** v1 superseded 2026-04-27.
**Do not use the address in this folder for new work.**

## Canonical replacement

| | v1 (this folder) | redeploy |
|---|---|---|
| Aptos mainnet address | `0x45aeb4023c7072427820e72fc247180f56c3d8d381ce6d8ee9ee7bc671d7dfc5` | `0xb6ca26fade34212464f475f95ef49257d3f7c4e22907a622c94d319a2648f714` |
| Module | `darbitex_lp_locker::lock` | `darbitex_lp_locker::lock` |
| Source on disk | `lp-locker/` | `lp-locker-redeploy/` |
| Upgrade authority | 3/5 multisig (live, soakable) | 6/6 multisig with `0xdead` unsignable owner — quorum unreachable, effectively immutable |
| `unlock_at` field | `unlock_at: u64` | renamed `unlock_at_seconds: u64` |
| WARNING constant | absent | 10-item disclosure + `read_warning()` `#[view]` |
| `claim_fees_assets` non-entry primitive | absent | added (downstream wrappers compose against it) |
| `redeem_position` non-entry primitive | absent | added |
| Views `is_unlocked`, `position_shares` | absent | added |

## Why deprecated

The v1 design predates the Sui port. The Sui locker + staking went through 4 audit rounds (R1..R4) and surfaced architectural and disclosure gaps — none safety-critical for the locker module specifically, but the bundled staking package needed several composition primitives (non-entry FA-returning fees, position-handle return on redeem) that v1 lacks. Adding these to v1 in place was not possible under Aptos `compatible` upgrade policy because the field rename `unlock_at` → `unlock_at_seconds` is a breaking layout change.

## What v1 does

The v1 module is still live on chain at `0x45aeb4023c707...` and remains functionally correct. Existing locked positions there can still:
- `claim_fees` — works
- `redeem` after `unlock_at` — works

There is no need to migrate existing v1 lockers, and there is no migration path. v1 lockers should be allowed to expire and redeem naturally. New locks should use the redeploy at `0xb6ca26fa...`.

## Audit history (v1)

`docs/AUDIT-LOCKER-SUBMISSION.md` + `docs/audit-responses/{gemini,deepseek,kimi,grok,qwen}-r1.md` — 5/5 R1 GREEN, kept for transparency.

## Resume

For new locker work: `lp-locker-redeploy/` and `tag lp-redeploy-v0.1.0`.
