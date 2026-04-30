# Walrus Quilt Registry — Darbitex Final Frontend

Source of truth for which Walrus blobs back the live Darbitex Final site.
Cross-check this file against on-chain state before any deploy, extend,
share, or burn operation. Same safety warnings and SOPs apply as the beta
equivalent — see
`~/darbitex-beta/frontend/docs/walrus-quilts.md` for the long-form
rationale behind short leases, shared blob funding risks, and deploy
checklists.

## Live site

- **Site Object ID:** `0x55103b69b54462f9efc7f58c3c6d134702662a7112e3e4e418bea13cf08163b4`
- **SuiNS binding:** `darbitex.sui` → `darbitex.wal.app` — **LIVE** as of 2026-04-15 via ControllerV2 `set_user_data` (tx `ArDXs3FTyV26juAoQeCwtPuB33z76PuWNATA6SRHyG31`). Previously bound to beta object `0x050df98f...`.
- **Walrus network:** mainnet
- **Operational wallet:** `0x6915bc38bccd03a6295e9737143e4ef3318bcdc75be80a3114f317633bdd3304` (`~/.sui/sui_config/client.yaml`)
- **SuiNS registration NFT:** `0x1700cba4a0eb8b17f75bf4e446144417c273b122f15b04655611c0233591d719` (holds `darbitex.sui`)
- **Blob ownership model:** shared (policy — see beta doc)

## Active shared quilts

Last verified: **2026-04-29** (epoch 382 testnet calendar / mainnet epoch ~30, epoch duration 14 days).

| # | Shared Object ID | Blob ID (content hash) | Size | Exp. epoch | Exp. date | Resources |
|---|---|---|---|---|---|---|
| 13 | `0x1c8fecd80fbc1eb9ee9e802c7b3c03ed1de337d31ca0b7f823362ccb830522f5` | `ROrxpiGeTOx9JmOs-6ilvwVsQ-YzZDMV-4fOifLMSQg` | 2.12 MiB | 34 | ~2026-07-06 | **D Aptos port — `/one` route fully replaced by `/d`** (D pkg `0x587c8084…`, FA `0x9015d5a6…`). New `/d/donate` page (D→SP + APT→reserve, lifetime stats, recent-donations tables via `D::SPDonated` + `D::ReserveDonated` events on indexer). New chain bindings (`chain/d.ts`, `dErrors.ts`, `dFormat.ts`); legacy `chain/one*.ts` + `pages/one/` deleted. Overview adds protocol balance sheet showing all 5 FungibleStore balances (treasury + reserve_coll + sp_pool + sp_coll_pool + fee_pool, hardcoded `D_STORES`, read via `0x1::fungible_asset::balance`). SP page surfaces donation delta `sp_pool_balance - totals.totalSp`. Trade page gets niocoin-style quote-detail box (spot rate from direct-pool reserves, effective rate, color-coded price impact, LP fee, slippage tolerance, min received). About page rewrite: every ONE→D, satellite blurb expanded with 10/90 fee split + donate primitives, "When $DARBITEX?" launch criteria revised to D/DARBITEX seed `99 D / 99M DARBITEX`, LP staking activation declares `900M DARBITEX, max_rate 10/sec` plus full C-variant adoption-emission formula explainer (`emission_per_sec = total_staked / pool.lp_supply × max_rate_per_sec`, per-staker share independence, ~1042-day full-saturation runway). Self-audit: every D module call (10 views + 9 entries incl. donate_to_sp/donate_to_reserve) matches D.move signatures. Cost: 5.325 MFROST (~0.005 WAL) + 0.024 SUI gas. |
| 12 | `0xed2ac91dd18396612c144c6f9813e59261d0df2c5b38b739a6e03b10e38c78ae` | `OL5qapmXhu50dkc6X2K7WsIg2jPbeswMFMLRzyeNnRY` | 2.12 MiB | 34 | ~2026-07-06 | **ORPHANED — replaced by #13 on 2026-04-29.** Left to expire. (Was: LP locker + LP staking redeploy frontend wire-up.) — Aptos LP locker + LP staking v2 (multisig 6/6+0xdead at `0xb6ca26fa…`). `STAKING_PACKAGE` + `LOCKER_PACKAGE` both repointed; v1 addresses removed. Portfolio: `LockedPositionResource.unlock_at` → `unlock_at_seconds`; new Stake action on naked LP and locked LP cards; stake modal fetches matching reward pools (`LpRewardPoolCreated` event filter by `pool_addr`) and dispatches `stake_lp` / `stake_locked_lp` with wrapper-transferability + decimal-agnostic-emission disclosure. Staking page: `reward_pool_info` decode realigned (4th=`total_staked_shares`, 5th=`phys`, 6th=`committed_rewards` — `stake_target` slot removed); `stake_info` 4-tuple decode adds `locked_variant`; `unstake_lp` → typed `unstake_naked` / `unstake_locked` dispatch; create-pool form drops `stake_target` field and "Fee: 1 APT" label; directory header now surfaces "Staked %" + "Emit/sec" via `staked_fraction_bps` + `current_emission_rate_per_sec` views; locked-variant rows tagged. |
| 11 | `0xd9f67e6629f3d49e66aa5e028ef96a090b00a6f1ce2e300d997348a5c8b4d4d5` | `BzX7NO5xQCuRwKJPkU9MzP490Pw0q7j2zRX3gFyMgw4` | 2.12 MiB | 34 | ~2026-07-06 | **ORPHANED — replaced by #12 on 2026-04-27, then #13 supersedes the chain on 2026-04-29.** Left to expire. (Was: 7-nav merge + ONE absorb.) |
| 10 | `0xadd94a7ed6a83d0fbf3ca33420912c12015ea2a3ea8bd476a68a9caf8df6ae98` | `IOqlKUU6Jkh8I0CQKk98XfXlssklsqrYxZwMGMt4das` | 2.12 MiB | 33 | ~2026-06-22 | **ORPHANED — replaced by #11 on 2026-04-24.** Left to expire. |
| 9 | `0xbbe5960d658b840b513513c00b00cbe4e4cf526aecd302b6f449d557d5c51658` | `-PdAO5Kv6M-pEaChTEHQNmo92MIRfyYyxpRGbOncVi0` | 2.12 MiB | 33 | ~2026-06-22 | **ORPHANED — replaced by #10 on 2026-04-19.** Left to expire. |
| 8 | `0x319fa60a59d2000aaa07cae35a596652d9617e6bf30b8993b57ccc84c2ece964` | `VKKBU31-HybAD90CiXzpy3ZYWDjqFgfZOgc4WWH4ZYY` | 2.12 MiB | 33 | ~2026-06-22 | **ORPHANED — replaced by #9 on 2026-04-17.** Left to expire. |
| 7 | `0xe0ebd8e1890ca8ba56dc124207e2cead3b2c2d8d8319fa097b9a50c73e19de39` | `JdTIvKArablz0SKYIF39ovwr0sw7lLR2No2Y3HGq0nY` | 2.12 MiB | 33 | ~2026-06-22 | **ORPHANED — replaced by #8 on 2026-04-16.** Left to expire. |
| 6 | `0x66a8fa6b34622051b99de17fa00b27f5ebb1140f75c58ce21a0535a449d8fbf1` | `Qckp27xBxHpn0mJFOefc-nyUUHqMNisDv1XcyqMOmhY` | 2.12 MiB | 33 | ~2026-06-22 | **ORPHANED — replaced by #7 on 2026-04-16.** Left to expire. |
| 5 | `0x1f1571624c038dfd80adc4727400cbe665a93aec35f9092c047b654244ac7f8b` | `htC_lTxdk7YNvMejtwcDM4iSyB_q6CdJLLENbX_uwus` | 2.12 MiB | 33 | ~2026-06-22 | **ORPHANED — replaced by #6 on 2026-04-16.** Left to expire. |
| 4 | `0x8dbec1739ea346fa5d93f494de50ccf311225000c87ffa3f3bd74220e083bbd0` | `VWle4x3WgWC1_fOE6AHJAt5Yim8uBNT8cyJ2qS0UgsI` | 2.12 MiB | 33 | ~2026-06-22 | **ORPHANED — replaced by #5 on 2026-04-16.** Left to expire. |
| 3 | `0xb2a8cc47a232e66843c111f6bca720f789068a88146f4b07e5e807bdd102be27` | `UePDnSrsfbXAZokOcXOIUXNMqEal_6jOuUlw1p5mxwE` | 2.12 MiB | 33 | ~2026-06-22 | **ORPHANED — replaced by #4 on 2026-04-16.** Left to expire. |
| 2 | `0x6eac05c0969c81ffa429bbe8b8eef9c9adfe067539c12617e95d17bf94436339` | `ix5pr4pFD7mM4YGivnzBOK99qE7tCm334EkSjLwA2yw` | 2.12 MiB | 33 | ~2026-06-22 | **ORPHANED — replaced by #3 on 2026-04-16.** Left to expire. |
| 1 | `0x3364a735114f0dbf23a74d9f9094bf58a78095e606835bfee47396092b973dc0` | `YZBv8PpL7ws8FjMCfjtNVOTB3XJbYIQv7JKgpf9PwUM` | 2.12 MiB | 33 | ~2026-06-22 | **ORPHANED — left to expire.** |

Short lease (5 epochs) per the beta SOP. Not funded.

## Archival split — deferred

**Status:** intentionally deferred until feature-freeze of the frontend.

Beta's walrus-quilts SOP calls for a dev/archival split: the working
site iterates on short 5-epoch leases, and a separate archival site
object holds a frozen "v1.0 launch" snapshot funded to max lease
(53 epochs ≈ 2 years) as a permanent fallback.

Not implemented yet for Final because the frontend is still in rapid
iteration — any archival snapshot we publish now would be stale in a
few hours. Revisit when:

- Feature work slows to bug-fix-only
- A deploy candidate is chosen as the canonical "v1.0 launch"
- The dev/archival split's SuiNS arrangement is decided (separate
  subdomain like `darbitex-archive.wal.app`? same domain with
  fallback logic? needs a short spec)

Burden is low when we actually ship it: one `site-builder publish`,
one `walrus share`, one long-lease `walrus fund-shared-blob`. Costs
~0.08 WAL for 53 epochs storage on a ~2 MiB bundle.

**Superseded shared quilts:**
- `0x95d422b7306332ed81795e225b88ca0be1901e9d0f7ff87efa40d9da9406e615` (blob `7z1X6Y7THIURenvHJIFJFRdL3g1uCCnPn9_37AKGmc0`) — polish batch deploy 2026-04-15. Superseded by flashbot-panel deploy. Not funded, zero WAL loss.
- `0xbb18ac8c8aae55ef1e08eaeab53cb53733e7398354605a68260e09a6271803d9` (blob `JsJZqQ-Ma8fnOWuDNEqyH-Zjz9h0KeLc6mFXDrff-V8`) — venue-adapters deploy 2026-04-15. Not funded, zero WAL loss.
- `0x0130baf88b7b4f311d83b3796c6cecb674d9c3223bee8e5b5e4f9e4a2f232c1b` (blob `HCZcwMsBOuf4tz25kdaAuRkNWbBzaIn_k7eKu4QikpU`) — balance-fix + auto-calc deploy 2026-04-15. Not funded, zero WAL loss.

**Burned owned blobs:**
- `0x5b65666cd84670fd74ad9f203d014748c09e5a31159032c09b0743d92cf211c5` (blob `tBm23JeUKeeKHbubQwDvFo3kAJV2WNMyU5YCVkRGxus`) — initial publish quilt. Superseded by the balance-fix update before ever being shared. Burned 2026-04-15, zero WAL loss.

## SuiNS repoint recipe (working 2026-04-15)

Done via `sui client call` against SuiNS ControllerV2. Same recipe used
for the 2026-04-15 flip from beta → final:

```bash
sui client call \
  --package 0x71af035413ed499710980ed8adb010bbf2cc5cacf4ab37c7710a4bb87eb58ba5 \
  --module controller \
  --function set_user_data \
  --args \
    0x6e0ddefc0ad98889c04bab9639e512c21766c5e6366f89e696956d9be6952871 \
    0x1700cba4a0eb8b17f75bf4e446144417c273b122f15b04655611c0233591d719 \
    "walrus_site_id" \
    "0x55103b69b54462f9efc7f58c3c6d134702662a7112e3e4e418bea13cf08163b4" \
    0x6 \
  --gas-budget 50000000
```

Args in order:
1. SuiNS shared object `0x6e0ddefc...2871`
2. `darbitex.sui` registration NFT `0x1700cba4...9d719`
3. Key: literal string `"walrus_site_id"`
4. Value: target site object ID as a 0x-prefixed hex string
5. Clock `0x6`

ControllerV2 `0x71af0354...58ba5` is the authorized controller —
the original `0xb7004c79...` package fails with `assert_app_is_authorized`.

Always dry-run first (`--dry-run`) to catch arg errors before spending
gas. Cost: ~0.0016 SUI.

## Deploy history

- **2026-04-15 initial publish:** `site-builder publish --epochs 5 dist --site-name "Darbitex"` → site object `0x55103b69...`, owned blob `0x5b65666c...`. Initial bundle (no balance fix).
- **2026-04-15 balance-fix update:** `site-builder update` → owned blob `0x71f9f475...` → shared `0x0130baf8...`, orphan `0x5b65666c...` burned.
- **2026-04-15 SuiNS repoint:** ControllerV2 `set_user_data(walrus_site_id = 0x55103b69...)` — tx `ArDXs3FTyV26juAoQeCwtPuB33z76PuWNATA6SRHyG31`. `darbitex.wal.app` now serves Final.
- **2026-04-16 DARBITEX token + balance/USD:** `site-builder update` → owned blob `0xb78291dc...` → shared `0x319fa60a...`. DARBITEX in all dropdowns, balance + USD on all pages, token icons in Vault/Staking, factory CSS fix, chunk warning suppressed.
- **2026-04-16 vault/staking/about rewrite:** `site-builder update` → owned blob `0xce130512...` → shared `0xe0ebd8e1...`. Vault + Staking reward pool creation UX, custom token selector, onepager + About page rewrite with full satellite ecosystem coverage, hard disclaimer (AI-built, experimental, use=agree).
- **2026-04-15 tagline fix update:** `site-builder update` → owned blob `0x4a4ac231...` → shared (cosmetic RPC lag on share tx, succeeded). Content blob `qoQCLEzcgWJ84cv4igjivwMJ0R5teDef6bSmaVayy1s`. Tagline changed from "Programmable Arbitrage AMM on Aptos" to "Decentralized Arbitrage Exchange on Aptos" (beta's original "permissionless V4 hooks DEX" tag was misleading — Final's novelty is CoW-inspired surplus-fee economics, not V4 hooks).
- **2026-04-19 Disperse page:** `site-builder update` → owned blob `0x72ca6afa...` → shared `0xadd94a7e...`. New `/disperse` route (bulk FA airdrop via `DISPERSE_PACKAGE` `0x3b9514c8...d95a` 3/5 multisig). 3 recipient sources (CSV paste, FA holders, NFT holders — via Aptos indexer GraphQL with Geomi API key). Token dropdown from `TOKENS` config + "Custom token…" fallback that auto-resolves symbol+decimals via `fungible_asset::{symbol,decimals}`. 600 recipients/batch (< 64 KB payload), uniform/custom amount modes, window.confirm gate when total protocol fee ≥ 5 APT. Nav restyled (10/11px padding, 12px font) to fit 11th item.
- **2026-04-29 D Aptos port — `/one` replaced by `/d`:** `site-builder update --epochs 5` → owned blob `0xb869e4f7...` → shared `0x1c8fecd80fbc1eb9ee9e802c7b3c03ed1de337d31ca0b7f823362ccb830522f5` (blob ID `ROrxpiGeTOx9JmOs-6ilvwVsQ-YzZDMV-4fOifLMSQg`). Cost: 5.325 MFROST (~0.005 WAL) + 0.024 SUI gas. D pkg `0x587c8084…`, FA `0x9015d5a6…`, MIN_DEBT 0.1 D. New `/d/donate` route modeled on niocoin pattern (D→SP + APT→reserve panels, lifetime stats from `D::SPDonated`+`D::ReserveDonated` events, recent-donations tables, permanent-irrevocable warning). Chain bindings ported (`chain/d.ts` + `dErrors.ts` + `dFormat.ts`); legacy `chain/one*.ts` + `pages/one/` + `pages/One.tsx` deleted; ONE removed from TOKENS whitelist. Overview adds **protocol balance sheet** (all 5 FungibleStore balances: treasury/reserve_coll/sp_pool/sp_coll_pool/fee_pool — hardcoded `D_STORES`, read via dedicated D views where available + `0x1::fungible_asset::balance` for the 3 stores D doesn't expose). Trade page gets niocoin-style quote-detail box: spot rate (direct-pool reserves snapshot), effective rate, color-coded price impact (good `<30bps`, warn `<100bps`, bad), LP fee (`1bps × hops` for Darbitex / "venue-defined" for external), slippage, min received — reserves fetched in parallel with executable quote so spot+executable share one snapshot. About rewrite: ONE→D throughout, satellite blurb adds 10/90 fee split + donate primitives, "When $DARBITEX?" launch criteria revised to seed `99 D / 99M DARBITEX`, LP staking activation `900M DARBITEX max_rate 10/sec` + full C-variant adoption-emission formula explainer + ~1042-day runway math. Self-audit confirmed zero ABI mismatches across all 10 D views + 9 D entries (incl. donate_to_sp/donate_to_reserve). Smoke: `/`, `/d`, `/d/donate`, `/d/sp`, `/about` all 200.
- **2026-04-27 LP locker + LP staking redeploy wire-up:** `site-builder update --epochs 5` → owned blob `0xb846c77a...` → shared `0xed2ac91d...` (blob ID `OL5qapmXhu50dkc6X2K7WsIg2jPbeswMFMLRzyeNnRY`). Cost: 5.325 MFROST (~0.005 WAL) + 0.024 SUI gas. `STAKING_PACKAGE` + `LOCKER_PACKAGE` repointed to `0xb6ca26fa…` (multisig 6/6+0xdead, effectively immutable). Portfolio Stake action + stake modal added; Staking page API decode + form realigned for v2 (`stake_target` field gone, `locked_variant` added, `unstake_naked`/`unstake_locked` dispatch). C-variant emission formula + STAKE WRAPPER TRANSFERABILITY warning surfaced inline. v1 addresses (`0x45aeb402...`, `0xeec9f236...`) no longer referenced. Live click-test pending.
- **2026-04-24 7-nav merge + ONE absorb:** `site-builder update --epochs 5` → owned blob `0x56420d30...` → shared `0xd9f67e66...` (blob ID `BzX7NO5xQCuRwKJPkU9MzP490Pw0q7j2zRX3gFyMgw4`). Cost: 5.325 MFROST (~0.005 WAL) + 0.084 SUI gas. Routes collapsed 11 → 7: Trade (was Swap+Aggregator merged, Aggregator superset) / Arbitrage / Liquidity (Pools+Portfolio subnav) / Earn (Vault+Staking subnav) / Tools (Factory+Disperse subnav, arb-wide) / ONE (6 sub-tabs) / About (Protocol absorbed as "live state" section). Legacy flat routes removed, no redirect shim. ONE stablecoin fully wired with live oracle (Pyth Hermes v2, number[][] VAA format per bootstrap.js pattern), on-chain `read_warning()` parsed & rendered as 9 red-numbered blocks, sealed-immutability proof section. Liquidate + Redeem-targeted auto-discover under-water / all-active troves via `account_transactions` + `user_transaction` GraphQL JOIN (replaces deprecated `events` v1 table, 2026-09-08 sunset). 19 ONE abort codes decoded to human strings. Disperse got Custom-per-recipient inline editor + Proportional-to-holdings mode (total pool / sumWeight × weight[i]) — pre-fill amounts from FA balance or NFT count. Staking's Create LP Reward Pool dropdown auto-fetches all pools from factory (no longer hardcoded INITIAL_POOLS). About's TVL + volume also discovery-dynamic via `get_all_pools` + `fetchFaMetadata`. TOKENS whitelist gained ONE (`0xee5ebaf6…`, 8-dec, `/tokens/one.svg`) + USD1 (WLFI, `0x31ac2b88…`, 6-dec, `/tokens/usd1.png`); order reshuffled APT / ONE / USDC / USDt / lzUSDC / lzUSDT / USD1 / DARBITEX. `ws-resources.json` **added** (Final was shipping without it — cause of the `/pools` 404-on-refresh pattern user flagged; fix also applies to all new subroutes). Trade balance-click-for-max regressed after Swap→Aggregator merge, restored. Factory Lookup Token row fixed (search button no longer covers input). About's "When $DARBITEX?" treasury bootstrap target bumped 100 → 200 APT with ONE/DARBITEX pool seed (99/99).

## Deploy checklist (MANDATORY ORDER)

1. `./node_modules/.bin/vite build` (or `npm run build`)
2. `site-builder update --epochs 5 dist 0x55103b69b54462f9efc7f58c3c6d134702662a7112e3e4e418bea13cf08163b4`
   - **Always** use `update`, never `publish` (SuiNS bound to the object ID above)
   - **Default `--epochs 5`** while frontend is iterating
3. `site-builder sitemap 0x55103b69...` — verify new resource → blob mapping
4. `walrus --context mainnet list-blobs` — find any new OWNED blobs
5. For each NEW owned blob: `walrus --context mainnet share --blob-obj-id <id>`
6. Re-run `walrus list-blobs` — MUST be empty
7. Update the table in this file with new shared object IDs + exp epochs.
   Move any newly-orphaned quilts to the "Superseded" list. Orphan owned
   blobs from a bad deploy that never made it to `share` can be burned
   safely via `walrus burn-blobs --object-ids <id>`.
8. Commit and push — the table on `main` must match on-chain reality

## Destructive-op safety rules

Same as beta doc — never `site-builder destroy`, never transfer the Site
object, burn orphans individually, shared blobs cannot be burned.
