# Darbitex Final — Deployments

All addresses are on **Aptos mainnet**. Publisher = package address for every
multisig-published package (standard Aptos pattern).

---

## Core

### Publisher multisig (= Final core package)

```
0xc988d39a4a27b26e1d659431a0c5828f3862c155d1c331386cd5974298dd78dd
```

- Threshold: **3/5**
- Upgrade policy: `compatible`
- Current version: `v0.2.0` (see [VERSIONS.md](./VERSIONS.md))
- Modules: `pool`, `pool_factory`, `arbitrage`

Owners:

| # | Address |
|---|---|
| 1 | `0x13f0c2edebcb9df033875af75669520994ab08423fe86fa77651cebbc5034a65` |
| 2 | `0xf6e1d1fdc2de9d755f164bdbf6153200ed25815c59a700ba30fb6adf8eb1bda1` |
| 3 | `0xc257b12ef33cc0d221be8eecfe92c12fda8d886af8229b9bc4d59a518fa0b093` |
| 4 | `0xa1189e559d1348be8d55429796fd76bf18001d0a2bd4e9f8b24878adcbd5e84a` |
| 5 | `0x0047a3e13465172e10661e20b7b618235e9c7e62a365d315e91cf1ef647321c9` (hot wallet, profile `final`) |

### Treasury multisig (fee recipient, `TREASURY` constant)

```
0xdbce89113a975826028236f910668c3ff99c8db8981be6a448caa2f8836f9576
```

- Threshold: **3/5**
- Used by: `arbitrage` module (surplus-fee recipient), flashbot (10% treasury cut)

Owners:

| # | Address |
|---|---|
| 1 | `0x85d1e4047bde5c02b1915e5677b44ff5a6ba13452184d794da4658a4814efd30` |
| 2 | `0x13f0c2edebcb9df033875af75669520994ab08423fe86fa77651cebbc5034a65` |
| 3 | `0xa1189e559d1348be8d55429796fd76bf18001d0a2bd4e9f8b24878adcbd5e84a` |
| 4 | `0xd2e046159d03cc7b4d0657d642a7c1eb7b3c10f55c4dc52fd62fd09957324150` |
| 5 | `0x953a05cf1b86e2f0cfa9bc300559cfcf1f441404bfefeb719a400aa529e01f70` |

---

## Satellites (in this repo)

### Flashbot (`flashbot/`)

| Field | Value |
|---|---|
| Package | `0x0047a3e13465172e10661e20b7b618235e9c7e62a365d315e91cf1ef647321c9` |
| Publisher | Hot wallet (same address) — **single-sig POC** |
| Threshold | 1/1 |
| Upgrade policy | `compatible` |
| Module | `darbitex_flashbot::flashbot` |

### LP Locker (`lp-locker/`)

| Field | Value |
|---|---|
| Package / multisig | `0x45aeb4023c7072427820e72fc247180f56c3d8d381ce6d8ee9ee7bc671d7dfc5` |
| Threshold | **3/5** (same 5 owners as Final core) |
| Upgrade policy | `compatible` (will flip to `immutable` after soak) |
| Module | `darbitex_lp_locker::lock` |

### Token Factory (`token-factory/`)

| Field | Value |
|---|---|
| Package / multisig | `0xbaa604864b167f6fb139893ac68bc72c3ab7d57710de5d71531f09e45df00958` |
| Threshold | **3/5**, **FROZEN (immutable)** |
| Module | `darbitex_token_factory::factory` |

Tokens created via this factory:

| Token | FA address | Supply |
|---|---|---|
| DARBITEX | `0x8241d225df6dee465b2898686011c477d5863abccae16630c7145c3165e9c2d` | 1,000,000,000 (fixed, MintRef dropped) |

### Token Vault V2 (`token-vault/`)

| Field | Value |
|---|---|
| Package / multisig | `0x8f4060790bdba617a34d7c55e2332400b4f592cd1037aa9acd0620811155d4eb` |
| Threshold | **3/5**, **FROZEN (immutable)** |
| Module | `darbitex_vault::vault` |

### Token Vault V1 — **DEPRECATED**

| Field | Value |
|---|---|
| Package | `0x962ef10a...` (retroactive-drainage bug in `deposit_rewards`) |
| Status | DO NOT USE. Superseded by V2. |

### LP Staking (`staking/`)

| Field | Value |
|---|---|
| Package / multisig | `0xeec9f2361d1ae5e3ce5884523ad5d7bce6948d6ca12496bf0d8b8a6cbebaa050` |
| Threshold | **3/5** (same 5 owners as Final core) |
| Upgrade policy | `compatible` (tracks core) |
| Module | `darbitex_lp_staking::staking` |

---

## Related satellites (separate repos)

These integrate with Final core but live outside this repo. Listed here for
completeness; source + audits in their own repos.

| Satellite | Package | Threshold |
|---|---|---|
| Aggregator | `0x838a981b...` | 3/5 |
| Thala adapter | `0x583d93de...` | 3/5 |
| Hyperion adapter | `0x5b4bf2a4...` | — |
| Hyperion router | `0x4f54bca9333b94a334f0036fea3aa848e7722f7be0e63087cc4814c84797986a` | 3/5 |

---

## Quick lookup

| Label | Address |
|---|---|
| Final core | `0xc988d39a4a27b26e1d659431a0c5828f3862c155d1c331386cd5974298dd78dd` |
| Treasury | `0xdbce89113a975826028236f910668c3ff99c8db8981be6a448caa2f8836f9576` |
| Flashbot | `0x0047a3e13465172e10661e20b7b618235e9c7e62a365d315e91cf1ef647321c9` |
| LP Locker | `0x45aeb4023c7072427820e72fc247180f56c3d8d381ce6d8ee9ee7bc671d7dfc5` |
| Token Factory | `0xbaa604864b167f6fb139893ac68bc72c3ab7d57710de5d71531f09e45df00958` |
| Token Vault V2 | `0x8f4060790bdba617a34d7c55e2332400b4f592cd1037aa9acd0620811155d4eb` |
| LP Staking | `0xeec9f2361d1ae5e3ce5884523ad5d7bce6948d6ca12496bf0d8b8a6cbebaa050` |
| DARBITEX token | `0x8241d225df6dee465b2898686011c477d5863abccae16630c7145c3165e9c2d` |
