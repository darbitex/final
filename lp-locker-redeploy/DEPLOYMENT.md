# Mainnet deployment — Darbitex LP Locker (redeploy)

**Status:** LIVE on Aptos mainnet, governance frozen via multisig 6/6 + unsignable owner.

## Live address

| | Value |
|---|---|
| Module | `0xb6ca26fade34212464f475f95ef49257d3f7c4e22907a622c94d319a2648f714::lock` |
| Publisher | multisig at the same address |
| Network | Aptos mainnet |
| Deployed | 2026-04-27 |
| Tag | `lp-redeploy-v0.1.0` |
| `upgrade_policy` (Move.toml) | `compatible` |
| Effective seal | YES (see governance below) |

## Governance — multisig 6/6 with `0xdead`

The multisig publisher has **6 owners**, threshold **6/6**:

| # | Owner | Status |
|---|---|---|
| 1 | `0x13f0c2edebcb9df033875af75669520994ab08423fe86fa77651cebbc5034a65` | real |
| 2 | `0xf6e1d1fdc2de9d755f164bdbf6153200ed25815c59a700ba30fb6adf8eb1bda1` | real |
| 3 | `0xc257b12ef33cc0d221be8eecfe92c12fda8d886af8229b9bc4d59a518fa0b093` | real |
| 4 | `0xa1189e559d1348be8d55429796fd76bf18001d0a2bd4e9f8b24878adcbd5e84a` | real |
| 5 | `0x0047a3e13465172e10661e20b7b618235e9c7e62a365d315e91cf1ef647321c9` | real |
| 6 | `0x000000000000000000000000000000000000000000000000000000000000dead` | **unsignable** |

`0xdead` has no private key. With threshold 6/6, the multisig can never reach quorum → upgrades are permanently impossible. This achieves effective immutability without setting `upgrade_policy = "immutable"` (which Aptos blocks via `EDEP_WEAKER_POLICY` because the `darbitex` core dependency is still in `compatible` soak).

## Deployment transactions

| Step | Tx hash | Version |
|---|---|---|
| Multisig create (5 owners, 1/5 threshold) | `0x3259cb459c2a27fd12246cc634115668c26e97d84fb666adf3d6f218408ead69` | 5025953310 |
| Locker propose (hash-only) | `0x787822b9...` | 5025973961 |
| Locker execute (publish) | `0x44eb0f10...` | 5025976040 |
| Add `0xdead` propose | (8) | 5026051442 |
| Add `0xdead` execute | (9) | 5026053434 |
| Raise threshold 1→6 propose | (10) | 5026063264 |
| Raise threshold 1→6 execute (FREEZE) | (11) | 5026064907 |

## Aptos Explorer

- Account: https://explorer.aptoslabs.com/account/0xb6ca26fade34212464f475f95ef49257d3f7c4e22907a622c94d319a2648f714?network=mainnet
- Module: https://explorer.aptoslabs.com/account/0xb6ca26fade34212464f475f95ef49257d3f7c4e22907a622c94d319a2648f714/modules/code/lock?network=mainnet

## On-chain disclosure

`read_warning(): vector<u8>` returns a 10-item disclosure including the upgrade-policy clause that explicitly notes the multisig governance freeze.

## Source verification

This folder's source is the canonical source. Build under Aptos CLI 9.1.0 with:

```bash
aptos move compile --named-addresses darbitex_lp_locker=0xb6ca26fade34212464f475f95ef49257d3f7c4e22907a622c94d319a2648f714
```

Bytecode size: 7048 bytes.

## Deprecates v1

v1 locker at `0x45aeb4023c7072427820e72fc247180f56c3d8d381ce6d8ee9ee7bc671d7dfc5` is superseded. See `../lp-locker/DEPRECATED.md`.

## Earlier-session orphan

During session evaluation, an interim hot-wallet deploy was made at:
- `0x0047a3e13465172e10661e20b7b618235e9c7e62a365d315e91cf1ef647321c9::lock` (mainnet, ORPHANED)
- `0x1cce6309159abafcbee4214e11c6b515f6242e64008c4c9ce3e2d5a6da97abaa::lock` (testnet, smoke fixture)

These should NOT be referenced by frontends or downstream protocols.
