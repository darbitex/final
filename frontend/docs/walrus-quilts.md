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

Last verified: **2026-04-15** (epoch 28, epoch duration 14 days).

| # | Shared Object ID | Blob ID (content hash) | Size | Exp. epoch | Exp. date | Resources |
|---|---|---|---|---|---|---|
| 1 | *(look up via explorer — share tx hit cosmetic RPC lag error but succeeded; list-blobs confirms)* | `qoQCLEzcgWJ84cv4igjivwMJ0R5teDef6bSmaVayy1s` | 1.70 MiB | 33 | ~2026-06-22 | full bundle — tagline fix ("Decentralized Arbitrage Exchange on Aptos") |

Short lease (5 epochs) per the beta SOP. Not funded.

**Superseded shared quilts:**
- `0x0130baf88b7b4f311d83b3796c6cecb674d9c3223bee8e5b5e4f9e4a2f232c1b` (blob `HCZcwMsBOuf4tz25kdaAuRkNWbBzaIn_k7eKu4QikpU`) — balance-fix + auto-calc deploy 2026-04-15. Superseded within hours by tagline-fix deploy. Not funded, zero WAL loss.

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
- **2026-04-15 tagline fix update:** `site-builder update` → owned blob `0x4a4ac231...` → shared (cosmetic RPC lag on share tx, succeeded). Content blob `qoQCLEzcgWJ84cv4igjivwMJ0R5teDef6bSmaVayy1s`. Tagline changed from "Programmable Arbitrage AMM on Aptos" to "Decentralized Arbitrage Exchange on Aptos" (beta's original "permissionless V4 hooks DEX" tag was misleading — Final's novelty is CoW-inspired surplus-fee economics, not V4 hooks).

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
