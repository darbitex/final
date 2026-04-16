import { Network } from "@aptos-labs/ts-sdk";

// Darbitex Final v0.1.0 — LIVE on Aptos mainnet. Same address as the
// publisher multisig (3-of-5). Compatible upgrade policy during soak,
// flips to immutable after.
export const PACKAGE =
  "0xc988d39a4a27b26e1d659431a0c5828f3862c155d1c331386cd5974298dd78dd";

// ThalaSwap V2 adapter satellite — primitive-only wrapper around
// thalaswap_v2::pool preview/swap with FA-native interface. 3/5
// multisig. Exposes adapter::quote (view) + adapter::pool_assets
// (view) + adapter::swap_entry (tx).
export const THALA_ADAPTER_PACKAGE =
  "0x583d93de79a3f175f1e3751513b2be767f097376f22ea2e7a5aac331e60f206f";

// Beta's aggregator satellite — ships Hyperion + Cellana wrappers as
// primitive-only Move view/entry functions. Final re-uses it directly
// for external-venue quoting + execution; no redeploy needed.
// Exposes: aggregator::{hyperion_pool_exists, hyperion_get_pool,
// quote_hyperion, swap_hyperion, quote_cellana, swap_cellana}.
export const AGGREGATOR_PACKAGE =
  "0x838a981b43c5bf6fb1139a60ccd7851a4031cd31c775f71f963163c49ab62b47";

// darbitex-flashbot POC v0.1 — cross-venue flash-arb satellite.
// Single entry function `run_arb(caller, borrow_asset, borrow_amount,
// other_asset, darbitex_swap_pool, thala_swap_pool, thala_first,
// min_net_profit, deadline)`. Borrows from Aave (0 fee), swaps
// through Darbitex + Thala in caller-chosen order, splits profit
// 90% caller / 10% treasury (same hardcoded treasury as Final).
// Single-sig publish under Final's hot wallet for POC velocity.
// Two smoke-test txs on mainnet 2026-04-15 both succeeded at 100k
// octas — see darbitex_final_deployed memory for tx hashes + decoded
// events.
export const FLASHBOT_PACKAGE =
  "0x0047a3e13465172e10661e20b7b618235e9c7e62a365d315e91cf1ef647321c9";

// Hyperion CLMM: we only query tier 1 (5 bps). Retired the 6-tier
// enumeration on 2026-04-14 — mainnet scan verified only tier 1 holds
// meaningful liquidity, the other five are dust or empty, so probing
// them burned 15 RPC calls per quote for zero benefit.
export const HYPERION_ACTIVE_TIER = 1;

// Curated Thala V2 pool seeds. Assets are discovered at runtime via
// adapter::pool_assets. Adding a new Thala pool means appending its
// address here — no Move or TypeScript changes required.
export const THALA_POOL_SEEDS: string[] = [
  // APT / USDC (native Circle) WEIGHTED — 5 bps. Prime flashbot
  // target: round-trip cost with Darbitex's 1 bps pool is ~6 bps.
  "0xa928222429caf1924c944973c2cd9fc306ec41152ba4de27a001327021a4dff7",
  // APT / USDt (native Tether) WEIGHTED — 30 bps. High-fee outlier,
  // kept for Aggregator quote comparison only. Not a flashbot target.
  "0x99d34f16193e251af236d5a5c3114fa54e22ca512280317eda2f8faf1514c395",
  // APT / USDt (native Tether) STABLE — 1 bps. Lowest Thala V2 fee
  // but the curve assumes parity, so any non-tiny size slips hard.
  // $36 TVL confirms LPs avoid it. Use for flashbot SMOKE-TEST /
  // micro-arb only; never for production-sized arb.
  "0x7845c59627bf2ecd0a8d4e2e83f0008546868442c3027060f042398578213164",
  // APT / lzUSDC (LayerZero-bridged) WEIGHTED — 5 bps. Second prime
  // flashbot target alongside the native USDC pool.
  "0x253f970b6a6f071b5fb63d3f16ea2685431a078f62bf98978b37bd0d169ff7c5",
];

// Token Factory satellite — fire-and-forget FA creator. FROZEN (immutable).
// 3/5 multisig (same owners as PACKAGE). Tiered ENS-style pricing,
// ASCII-only symbols, fixed 1B supply, self-burn via BurnCap.
export const FACTORY_PACKAGE =
  "0xbaa604864b167f6fb139893ac68bc72c3ab7d57710de5d71531f09e45df00958";

// Token Vault satellite V2 — lock/vest/stake for ANY FA token.
// 3/5 multisig (same owners as PACKAGE). FROZEN (immutable).
// V1 at 0x962ef10a... DEPRECATED (retroactive drainage bug in deposit_rewards).
export const VAULT_PACKAGE =
  "0x8f4060790bdba617a34d7c55e2332400b4f592cd1037aa9acd0620811155d4eb";

// LP Staking satellite — stake Darbitex LP positions, earn rewards.
// 3/5 multisig (same owners as PACKAGE). Compatible (follows core).
export const STAKING_PACKAGE =
  "0xeec9f2361d1ae5e3ce5884523ad5d7bce6948d6ca12496bf0d8b8a6cbebaa050";

// LP Locker satellite — wraps LpPosition with time-based unlock.
// 3/5 multisig (same owners as PACKAGE). claim_fees always allowed;
// redeem gated by unlock_at.
export const LOCKER_PACKAGE =
  "0x45aeb4023c7072427820e72fc247180f56c3d8d381ce6d8ee9ee7bc671d7dfc5";

// Hardcoded Move constant in arbitrage.move. 3-of-5 multisig.
export const TREASURY =
  "0xdbce89113a975826028236f910668c3ff99c8db8981be6a448caa2f8836f9576";

// TREASURY_BPS = 1_000 (10%) on measurable surplus — hardcoded on-chain.
export const TREASURY_BPS = 1000;

// LP fee on the x*y=k pool primitive. 1 bps. 100% to LPs; no passive slot.
export const POOL_FEE_BPS = 1;

// Geomi (Aptos Labs developer portal) frontend API key. Domain-restricted
// server-side: only accepted when `Origin` header matches a whitelisted
// URL on the Geomi dashboard (darbitex.wal.app + localhost). A leaked key
// is useless to anyone who can't fake Origin — impossible from browsers.
//
// Same key shared with Beta since both frontends serve from the same
// `darbitex.wal.app` origin (Final takes over the URL via a new Walrus
// site object + SuiNS repoint at deploy time).
export const GEOMI_API_KEY = "AG-95EUWG1FUEIKI1QAG1EAAWFRFVQNOJURS";

export type RpcEndpoint = {
  url: string;
  headers?: Record<string, string>;
};

// Primary: Geomi-authenticated Node API. Our own quota bucket.
// Fallbacks: anonymous Aptos Labs public hostnames for graceful
// degradation if Geomi is unreachable.
export const RPC_LIST: RpcEndpoint[] = [
  {
    url: "https://api.mainnet.aptoslabs.com/v1",
    headers: { Authorization: `Bearer ${GEOMI_API_KEY}` },
  },
  { url: "https://fullnode.mainnet.aptoslabs.com/v1" },
  { url: "https://mainnet.aptoslabs.com/v1" },
];

export const NETWORK = Network.MAINNET;

// Default slippage tolerance for user swaps. 50 bps.
export const SLIPPAGE = 0.005;

// Aggregator quote debounce. Matches the conservative tuning that
// survived the 2026-04-14 rate-limit storms on Beta.
export const QUOTE_DEBOUNCE_MS = 2000;

export type TokenConfig = {
  meta: string;
  decimals: number;
  symbol: string;
  /// Optional icon URL relative to the site root. Whitelisted tokens
  /// ship bundled SVGs from public/tokens/; custom tokens resolved via
  /// CreatePool "Other…" paste path rely on on-chain FA metadata's
  /// icon_uri as a fallback.
  icon?: string;
};

// On-chain verified FA metadata addresses (same as Beta — canonical
// across the Aptos ecosystem, not Darbitex-specific).
export const TOKENS: Record<string, TokenConfig> = {
  APT: {
    meta: "0x000000000000000000000000000000000000000000000000000000000000000a",
    decimals: 8,
    symbol: "APT",
    icon: "/tokens/apt.svg",
  },
  USDC: {
    meta: "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b",
    decimals: 6,
    symbol: "USDC",
    icon: "/tokens/usdc.svg",
  },
  USDt: {
    meta: "0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b",
    decimals: 6,
    symbol: "USDt",
    icon: "/tokens/usdt.svg",
  },
  lzUSDC: {
    meta: "0x2b3be0a97a73c87ff62cbdd36837a9fb5bbd1d7f06a73b7ed62ec15c5326c1b8",
    decimals: 6,
    symbol: "lzUSDC",
    icon: "/tokens/lzusdc.svg",
  },
  lzUSDT: {
    meta: "0xe568e9322107a5c9ba4cbd05a630a5586aa73e744ada246c3efb0f4ce3e295f3",
    decimals: 6,
    symbol: "lzUSDT",
    icon: "/tokens/lzusdt.svg",
  },
  DARBITEX: {
    meta: "0x8241d225df6dee465b2898686011c477d5863abccae16630c7145c3165e9c2d",
    decimals: 8,
    symbol: "DARBITEX",
    icon: "/tokens/darbitex.svg",
  },
};

export type PoolSeed = {
  address: string;
  symbolA: string;
  symbolB: string;
};

// The 6 pools live at publish. Addresses pinned here for the Pools page
// cold-start; the factory reader `get_all_pools` is still the source of
// truth and runs on first mount to catch any new permissionless pools.
export const INITIAL_POOLS: PoolSeed[] = [
  {
    address:
      "0x33afff96c0e4e61ad72a846a54d65275a44a6e048675ddf32efa2492e5781110",
    symbolA: "APT",
    symbolB: "USDt",
  },
  {
    address:
      "0x3837eff0c53a8a23c9f8242267736639945047fe30dce648f939ac08f8ad5811",
    symbolA: "APT",
    symbolB: "USDC",
  },
  {
    address:
      "0x6cc10b66311aa719fdd4842631caa5554938e13266f211a8a6aa5e88b76a1889",
    symbolA: "APT",
    symbolB: "lzUSDC",
  },
  {
    address:
      "0x10809011876bd75b6e14392e272aa59a3ec88e9766fe4c9d67c46c140c975df7",
    symbolA: "APT",
    symbolB: "lzUSDT",
  },
  {
    address:
      "0x1574c4039ed1a10c91feeb11c7b77510a9651ee973cb1cfb1de78dc2745aa555",
    symbolA: "USDt",
    symbolB: "lzUSDT",
  },
  {
    address:
      "0x3ddc57a06513e49aa8f9615c517fffc5f976a5247f9d07a37a03789033b4ddfd",
    symbolA: "lzUSDC",
    symbolB: "USDC",
  },
];
