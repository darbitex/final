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
| Modules | `darbitex_flashbot::flashbot` (user-facing `run_arb` / `run_arb_hyperion` / `run_arb_cellana`) |

### TWAMM (`twamm/`) — LIVE

| Field | Value |
|---|---|
| Package / multisig | `0x9df06f93369effe15ab626044bbbcb03e6bf198af909ac4c133719e637771cf4` |
| Threshold | **3/5** (bootstrapped 1/5 → raised 2026-04-20) |
| Upgrade policy | `compatible` |
| Modules | `darbitex_twamm::bridge` (friend-only MEV composer), `darbitex_twamm::executor` (keeper-gated virtual order runner) |
| Version | `v0.1.1` (v0.1.0 published + v0.1.1 thala::swap param fix applied pre-smoke) |
| Audit | R5.1 — 7 independent green: Opus self, Gemini 3 Flash, Kimi K2.5, Grok (xAI), Qwen, OpenHands, DeepSeek. See `Audit-R5-Bundle.md`. |
| Oracle | `EmaOracle` initialized from Darbitex pool `0x3837eff0...` (APT/USDC, reserves 361M/3.55M octas) |
| Keeper whitelist | `0x0047a3e13465172e10661e20b7b618235e9c7e62a365d315e91cf1ef647321c9` |
| External deps (mainnet) | Aave `0x39ddcd9e...` (flash, 0 fee verified), Thala V2 `0x7730cd28...` (APT/USDC 5bps pool `0xa928...`) |

Owners (Pattern A — same as Final core):

| # | Address |
|---|---|
| 1 | `0x0047a3e13465172e10661e20b7b618235e9c7e62a365d315e91cf1ef647321c9` (hot, profile `final`, proposer) |
| 2 | `0x13f0c2edebcb9df033875af75669520994ab08423fe86fa77651cebbc5034a65` |
| 3 | `0xf6e1d1fdc2de9d755f164bdbf6153200ed25815c59a700ba30fb6adf8eb1bda1` |
| 4 | `0xc257b12ef33cc0d221be8eecfe92c12fda8d886af8229b9bc4d59a518fa0b093` |
| 5 | `0xa1189e559d1348be8d55429796fd76bf18001d0a2bd4e9f8b24878adcbd5e84a` |

Key transactions:
- Multisig create: `0xc65348bfe69da5b32f5bfaf6dccb6de457c17e2b583e693a923ca6ff672e9888`
- Package publish (v0.1.0): version `4942424268`, tx `0x3489031ef9fb73c9de660269a1c3615746c5068ce5fffd162f78d6453e82aff5`
- Package upgrade (v0.1.1, thala::swap param fix): version `4942656615`
- `init_ema_from_pool`: version `4942437741`
- `add_keeper(0x0047)`: version `4942441312`
- First (broken) smoke: tx `0x2ae17293049223c6495edda7820d29676b39a772e7811e81534a18eeeb20de8d` — aborted `E_MIN_OUT` due to v0.1.0 bridge bug
- Final (green) smoke: version `4942678952` — 0.00208 APT → 0.001944 USDC via Thala 5bps, `arb_executed: false` (expected — no price divergence)
- Threshold raise to 3/5: immediately after smoke

**Architecture note**: `bridge.move` lives in the **twamm package**, not flashbot. Aptos Move requires `friend` declarations to reference modules at the same address. Since `bridge::omni_swap_thala_twamm` is `public(friend)` restricted to `executor`, the two modules must be colocated. The standalone `flashbot::run_arb*` entry points are unrelated user-facing flash-arb primitives and remain in the flashbot package.

**V1 scope**: Thala-only venue. This is a regression-from-R1 — R1 had three venues (`omni_swap_thala_twamm`, `omni_swap_hyperion_twamm`, `omni_swap_cellana_twamm`), R2 audit deleted the Hyperion/Cellana variants as "dead code" instead of adding the executor-side dispatcher. The `omni_swap` prefix in the remaining function name is the rhetorical tell.

**V2 PRIMARY TARGET**: restore multi-venue dispatcher (Candidate J in memory). This is not an optional future feature — it is the first V2 upgrade. Follow-up V2 candidates: `OrderCreated` event, per-pair `MAX_EMA_DEVIATION`, `force_update_oracle` deviation bound, `cancel_order` idempotent guard. Full candidate list + bundling strategy at `/home/rera/.claude/projects/-home-rera/memory/darbitex_twamm_v2_candidates.md`.

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
| Disperse | `0x3b9514c83249434306d69747a6e4eef303e6ac690fb6efc57fb0c23d7cc4d95a` | 3/5 |

### Disperse (`github.com/darbitex/darbitex-disperse`)

| Field | Value |
|---|---|
| Package / multisig | `0x3b9514c83249434306d69747a6e4eef303e6ac690fb6efc57fb0c23d7cc4d95a` |
| Threshold | **3/5** (bootstrapped 1/5 → raised 2026-04-19) |
| Upgrade policy | `compatible` |
| Module | `darbitex::disperse` |
| Fee recipient | Treasury `0xdbce8911...` |
| Fee | 1 APT flat per `disperse_uniform` / `disperse_custom` call |

Owners (swap 0x85 → 0x0047 vs Treasury):

| # | Address |
|---|---|
| 1 | `0x0047a3e13465172e10661e20b7b618235e9c7e62a365d315e91cf1ef647321c9` |
| 2 | `0x13f0c2edebcb9df033875af75669520994ab08423fe86fa77651cebbc5034a65` |
| 3 | `0xa1189e559d1348be8d55429796fd76bf18001d0a2bd4e9f8b24878adcbd5e84a` |
| 4 | `0xd2e046159d03cc7b4d0657d642a7c1eb7b3c10f55c4dc52fd62fd09957324150` |
| 5 | `0x953a05cf1b86e2f0cfa9bc300559cfcf1f441404bfefeb719a400aa529e01f70` |

**Deprecated orphan** — `0x5f79f1b5a0a4e9abd472054ba768a88187cad40a4e78107b731a482d2a55db3e::disperse` was an earlier hot-wallet deploy (2026-04-18). Neutered 2026-04-19 via upgrade `0xcb51f323...04f8`: all entry functions abort `E_DEPRECATED(999)`. Do not call.

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
| Disperse | `0x3b9514c83249434306d69747a6e4eef303e6ac690fb6efc57fb0c23d7cc4d95a` |
| DARBITEX token | `0x8241d225df6dee465b2898686011c477d5863abccae16630c7145c3165e9c2d` |
