# Mainnet deployment — Darbitex LP Staking (redeploy)

**Status:** LIVE on Aptos mainnet, governance frozen via multisig 6/6 + unsignable owner.

## Live address

| | Value |
|---|---|
| Module | `0xb6ca26fade34212464f475f95ef49257d3f7c4e22907a622c94d319a2648f714::staking` |
| Publisher | multisig at the same address (shared with locker module) |
| Network | Aptos mainnet |
| Deployed | 2026-04-27 |
| Tag | `lp-redeploy-v0.1.0` |
| `upgrade_policy` (Move.toml) | `compatible` |
| Effective seal | YES (see governance below) |

## Governance — multisig 6/6 with `0xdead`

Same multisig that publishes the locker. **6 owners, threshold 6/6**, owner #6 = `0x000...dead` (unsignable). Quorum unreachable → upgrades permanently impossible. See `../lp-locker-redeploy/DEPLOYMENT.md` for full owner list and rationale.

## Module dependencies

- `darbitex::pool` at `0xc988d39a4a27b26e1d659431a0c5828f3862c155d1c331386cd5974298dd78dd` (Darbitex Final core, `compatible` policy in soak)
- `darbitex_lp_locker::lock` at `0xb6ca26fade34212464f475f95ef49257d3f7c4e22907a622c94d319a2648f714` (this multisig, the locker module)

When core flips to `immutable` after its 3-6 month soak, the staking module's `upgrade_policy` field is irrelevant because the multisig is already frozen. Future verifiers can confirm seal status either via `aptos_framework::code::PackageRegistry` (for `upgrade_policy`) or via `aptos_framework::multisig_account` views (for owners + threshold).

## Deployment transactions

| Step | Tx hash | Version |
|---|---|---|
| Staking propose (hash-only) | `0xa7e6c6664f95a7b59138a26d4e8436fcc898a1ffbb368fd2f987502e27475193` | — |
| Staking execute (publish) | `0x5237795586c00acfa301c0ef9ab2199cc32bc02217002266626b2265fc9c1be7` | 5025989851 |

(Multisig create + locker publish + freeze sequence: see `../lp-locker-redeploy/DEPLOYMENT.md`.)

## Aptos Explorer

- Account: https://explorer.aptoslabs.com/account/0xb6ca26fade34212464f475f95ef49257d3f7c4e22907a622c94d319a2648f714?network=mainnet
- Module: https://explorer.aptoslabs.com/account/0xb6ca26fade34212464f475f95ef49257d3f7c4e22907a622c94d319a2648f714/modules/code/staking?network=mainnet

## On-chain disclosure

`read_warning(): vector<u8>` returns a 16-item disclosure including:
- (1) Multiple reward pools per Darbitex pool allowed (no singleton DoS)
- (8) Emission capped by free reward balance (`physical − committed`)
- (14) Accumulator overflow DOS mode (theoretical, ~1.8e7 calls under adversarial params)
- (15) Stake wrapper transferability (object::transfer carries economic rights)

## Build

```bash
aptos move compile --named-addresses \
  darbitex_lp_locker=0xb6ca26fade34212464f475f95ef49257d3f7c4e22907a622c94d319a2648f714,\
  darbitex_staking=0xb6ca26fade34212464f475f95ef49257d3f7c4e22907a622c94d319a2648f714
```

Bytecode size: 14468 bytes.

## R1 audit

External 6-LLM panel (Claude, Gemini, Kimi, DeepSeek, Qwen, Grok). 5 GREEN + 1 YELLOW (Qwen HIGH-1 cross-check rejected: misread of Move 2 abort + transactional rollback semantics; 3 peer auditors verified safe). Claude MED-1 (pool-match coupling) user-rejected as design accept (canonical-pair invariant is contractually held by `pool_factory`).

R1.1 patch batch applied: see `docs/R1-FINDINGS.md` for consolidation, `docs/audit-responses/<auditor>-r1.md` for verbatim per-auditor responses.

Tests: 24/24 PASS. See `tests/staking_tests.move`.

## Deprecates v1

v1 staking at `0xeec9f2361d1ae5e3ce5884523ad5d7bce6948d6ca12496bf0d8b8a6cbebaa050` is superseded. See `../staking/DEPRECATED.md`.

## Earlier-session orphan

During session evaluation, an interim hot-wallet deploy was made at:
- `0x0047a3e13465172e10661e20b7b618235e9c7e62a365d315e91cf1ef647321c9::staking` (mainnet, ORPHANED)
- `0x1cce6309159abafcbee4214e11c6b515f6242e64008c4c9ce3e2d5a6da97abaa::staking` (testnet, smoke fixture)

These should NOT be referenced by frontends or downstream protocols.
