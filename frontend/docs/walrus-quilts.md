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
- **SuiNS binding:** `darbitex.sui` → `darbitex.wal.app` (repoint from beta object `0x050df98f...` pending — see "SuiNS repoint" below)
- **Walrus network:** mainnet
- **Operational wallet:** `0x6915bc38bccd03a6295e9737143e4ef3318bcdc75be80a3114f317633bdd3304` (`~/.sui/sui_config/client.yaml`)
- **SuiNS registration NFT:** `0x1700cba4a0eb8b17f75bf4e446144417c273b122f15b04655611c0233591d719` (holds `darbitex.sui`)
- **Blob ownership model:** shared (policy — see beta doc)

## Active shared quilts

Last verified: **2026-04-15** (epoch 28, epoch duration 14 days).

| # | Shared Object ID | Blob ID (content hash) | Size | Exp. epoch | Exp. date | Resources |
|---|---|---|---|---|---|---|
| 1 | `0x0130baf88b7b4f311d83b3796c6cecb674d9c3223bee8e5b5e4f9e4a2f232c1b` | `HCZcwMsBOuf4tz25kdaAuRkNWbBzaIn_k7eKu4QikpU` | 1.70 MiB | 33 | ~2026-06-22 | full bundle — React 19 / Vite 6 / balance-fix + auto-calc add-liquidity deploy |

Short lease (5 epochs) per the beta SOP. Not funded. Will be superseded
on the next deploy; don't advertise public funding.

**Superseded shared quilts:**
- (none yet — initial deploy orphaned an owned blob which was burned, no shared orphans)

**Burned owned blobs:**
- `0x5b65666cd84670fd74ad9f203d014748c09e5a31159032c09b0743d92cf211c5` (blob `tBm23JeUKeeKHbubQwDvFo3kAJV2WNMyU5YCVkRGxus`) — initial publish quilt. Superseded by the balance-fix update before ever being shared. Burned 2026-04-15, zero WAL loss.

## SuiNS repoint (pending)

The new site object `0x55103b69...` is live but not yet bound to
`darbitex.wal.app` — SuiNS still points to the beta site object
`0x050df98f...`. To flip:

**Option A — SuiNS dApp (recommended, zero risk of wrong args):**
1. Open https://suins.io in a browser with the operational wallet
2. Find `darbitex.sui` in your names list
3. Click "Walrus Site" / "Set Walrus Site" (UI label varies)
4. Paste: `0x55103b69b54462f9efc7f58c3c6d134702662a7112e3e4e418bea13cf08163b4`
5. Sign transaction
6. Verify `https://darbitex.wal.app` serves the new site

**Option B — Sui CLI:**
The SuiNS package is `0xd22b24490e0bae52676651b4f56660a5ff8022a2576e0089f79b3c88d44e08f0`.
The Walrus-site name is stored in the SuiNS user data. The exact function
name varies by SuiNS version; consult the SuiNS docs for the current CLI
recipe before attempting. Do a dry-run first — a wrong arg burns gas.

## Deploy history

- **2026-04-15 initial publish:** `site-builder publish --epochs 5 dist --site-name "Darbitex"` → created site object `0x55103b69...`, owned blob `0x5b65666c...`. Initial frontend bundle (7 pages, no balance fix).
- **2026-04-15 balance-fix update:** `site-builder update --epochs 5 dist 0x55103b69...` → replaced all resources with new quilt, created owned blob `0x71f9f475...`. Then shared as `0x0130baf8...`, orphaned blob `0x5b65666c...` burned.

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
