# Darbitex Final Frontend — Changelog

All notable frontend changes. Each entry includes the Walrus quilt # and git commit for traceability.

---

## 2026-04-16 — LP Locker integration
**Quilt:** #3 (`0xb2a8cc47...`) | **Commit:** `b8f92cf`

### Added
- **Locked Positions section** on Portfolio page — auto-discovers `LockedPosition` objects via `getAccountOwnedObjects`, displays pair, shares, unlock date with countdown timer, Claim Fees and Redeem buttons.
- **Lock button** on each unlocked LP position card — opens lock modal.
- **Lock modal** with:
  - Date picker (min = tomorrow)
  - English warning box (5 bullets: no early exit, fees claimable while locked, immutable unlock date, transfer = lose access, zero admin override)
  - Checkbox agreement required before Lock button activates
- **`LOCKER_PACKAGE` constant** in `config.ts` (`0x45aeb402...`)
- **Lock-related CSS** — `.locked-card` orange left border, `.lock-badge` countdown pill, `.lock-warning` box, `.lock-input` date field, `.lock-checkbox`

### Fixed
- **LP position discovery pagination** — `getAccountOwnedObjects` limit raised from 200 to 500. Wallets with many FA stores (50+ tokens) were missing LP positions because they fell beyond the 200-object scan window. Single call (no loop) to respect RPC budget.
- Same pagination fix applied to `RemoveLiquidityModal.tsx`

### Changed
- `Portfolio.tsx` fully rewritten — split discovery into LP positions + locked positions, unified pool resolution cache, added locker-specific claim/redeem handlers routing through `LOCKER_PACKAGE::lock::claim_fees` / `redeem` instead of core's `pool::claim_lp_fees_entry`

### Files changed
| File | Delta |
|---|---|
| `src/config.ts` | +6 (LOCKER_PACKAGE) |
| `src/pages/Portfolio.tsx` | +389 −131 (rewrite) |
| `src/components/RemoveLiquidityModal.tsx` | +1 (pagination fix) |
| `src/styles.css` | +27 (lock styles) |

---

## 2026-04-15 — Flashbot 3-venue picker + token icons
**Quilt:** #2 (`0x6eac05c0...`) | **Commit:** `bce75ed`

### Added
- FlashbotPanel: 3-venue picker (Thala / Hyperion / Cellana) wired to `run_arb` / `run_arb_hyperion` / `run_arb_cellana`
- Bundled token icons (APT, USDC, USDt, lzUSDC, lzUSDT) as SVGs in `/public/tokens/`
- `TokenIcon` component with icon → `icon_uri` → letter-badge fallback chain
- Walrus deploy to new site object `0x55103b69...`, SuiNS repointed from beta

---

## 2026-04-14 — Initial launch (Aggregator + Swap + Pools + Portfolio)
**Quilt:** #1 (`0x3364a735...`) | **Commit:** (initial)

### Added
- 6 pages: Swap, Aggregator, Arbitrage, Pools, Portfolio, Protocol, About
- Wallet connection via @aptos-labs/wallet-adapter-react (Petra, OKX, Nightly, Google, Apple)
- RPC pool with rotation + cooldown (Geomi primary, Aptos Labs fallback)
- 4-venue aggregator: Darbitex, Hyperion, Cellana, Thala (via adapter)
- Portfolio: FA balances + LP position auto-discovery
- Pool creation, add/remove liquidity modals
- Slippage tolerance setter
- Dark theme (#0a0a0a), monospace, #ff8800 accent
