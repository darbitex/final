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

// Darbitex Hyperion Router — smart cross-tier + flash-arb satellite
// 3/5 multisig publisher. v0.2.0 live with on-chain events.
export const HYPERION_ROUTER_PACKAGE =
  "0x4f54bca9333b94a334f0036fea3aa848e7722f7be0e63087cc4814c84797986a";

// Hyperion pool_v3 type — for frontend type args when passing Object<Pool>.
export const HYPERION_POOL_TYPE =
  "0x8b4a2c4bb53857c718a04c020b98f8c2e1f99a68b0f57389a8bf5434cd22e05c::pool_v3::LiquidityPoolV3";

// Curated Thala V2 pool seeds. Assets are discovered at runtime via
// adapter::pool_assets. Adding a new Thala pool means appending its
// address here — no Move or TypeScript changes required.
export const THALA_POOL_SEEDS: string[] = [
  // APT / USDC (native Circle) WEIGHTED — 5 bps. Prime flashbot
  // target: round-trip cost with Darbitex's 5 bps pool is ~10 bps.
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

// LP Locker + LP Staking redeploy — co-published under multisig 6/6+0xdead
// (effectively immutable; quorum unreachable forever). Supersedes v1 locker
// 0x45aeb402... and v1 staking 0xeec9f236... — those are deprecated and not
// referenced by this frontend.
export const STAKING_PACKAGE =
  "0xb6ca26fade34212464f475f95ef49257d3f7c4e22907a622c94d319a2648f714";
export const LOCKER_PACKAGE =
  "0xb6ca26fade34212464f475f95ef49257d3f7c4e22907a622c94d319a2648f714";

// Disperse satellite — bulk FA airdrop (uniform + custom amounts).
// 3/5 multisig, owner set has 0x0047 swapped in for 0x85 vs treasury.
// Flat 1 APT fee per call to TREASURY. Compatible upgrade policy.
export const DISPERSE_PACKAGE =
  "0x3b9514c83249434306d69747a6e4eef303e6ac690fb6efc57fb0c23d7cc4d95a";

export const DISPERSE_FEE_OCTAS = 100_000_000n;
export const DISPERSE_MAX_PER_TX = 600;
export const DISPERSE_FEE_CONFIRM_THRESHOLD_OCTAS = 500_000_000n;

// D stablecoin (v0.2.0) — APT-collateralized, Pyth-oracled, sealed
// (resource-account ResourceCap destroyed 2026-04-29). Successor to
// ONE; same Liquity-descended core but with 0.1 D MIN_DEBT (cuts
// fee-cascade trap), oracle-free donate_to_sp / donate_to_reserve, and
// 10/90 fee split (10% direct to SP pool, 90% pro-rata to keyed SP
// depositors via fee accumulator).
export const D_PACKAGE =
  "0x587c80846b18b7d7c3801fe11e88ca114305a5153082b51d0d2547ad48622c77";
export const D_METADATA =
  "0x9015d5a6bbca103bc821a745a7fd3eb2ee1e535d3af65ac9fb4c7d308355c390";

// Pyth Aptos package + APT/USD feed id. HERMES is the off-chain VAA
// source — we fetch a signed price update, pass bytes to
// `pyth::update_price_feeds_with_funder` (called via `*_pyth` entry
// wrappers inside D.move), then consume the cached price.
export const PYTH_PACKAGE =
  "0x7e783b349d3e89cf5931af376ebeadbfab855b3fa239b7ada8f5a92fbea6b387";
export const APT_USD_PYTH_FEED =
  "0x03ae4db29ed4ae33d323568895aa00337e658e348b37509f5372ae51f0af00d5";
export const HERMES_ENDPOINT = "https://hermes.pyth.network";

// Five FungibleStore object addresses for D — all derived from the
// deployer GUID counter in init_module_inner and stable for the
// package lifetime. Hardcoded here so the balance sheet doesn't burn
// 5 extra RPCs per page load resolving them via the *_addr() views.
// Verifiable on-chain by calling D::{fee_pool,sp_pool,sp_coll_pool,
// reserve_coll,treasury}_addr().
export const D_STORES = {
  fee_pool: "0x9609e7dc1031ce34ae6ee032ac15a1370880f13af3a85202f86cc85c2458455a",
  sp_pool: "0x5e2b58e08a56a6d45a0ea8a043d47b68a9b2591a6eab89d931965ce68a5f89e2",
  sp_coll_pool: "0x9f7067b4ee7d088084bbefd7a31efbf1424ac9a2bf1c949942fd5f2fc9c58f31",
  reserve_coll: "0xf241ca7c86ace9e0a267abce9ea8fbce1d5a814fcace4f86e8dd0313c2622868",
  treasury: "0x9593efef231032c3988739aa7108af46e06f4e2c6a89e6b545f2dfb771c4a969",
} as const;

// Retail-first D parameters, locked at deploy. Sourced from D.move
// constants. LIQ_BONUS_BPS is the *total* bonus on debt; liquidator
// receives LIQ_LIQUIDATOR_BPS share of that, reserve gets
// LIQ_SP_RESERVE_BPS, the rest (50%) stays in the SP collateral pool.
// MIN_DEBT_RAW is 0.1 D (10_000_000) vs ONE's 1 ONE — the smaller
// floor avoids the fee-cascade trap where a 1% mint fee on a trove at
// MIN_DEBT can never be re-borrowed to close.
export const D_PARAMS = {
  MCR_BPS: 20000,
  LIQ_THRESHOLD_BPS: 15000,
  LIQ_BONUS_BPS: 1000,
  LIQ_LIQUIDATOR_BPS: 2500,
  LIQ_SP_RESERVE_BPS: 2500,
  FEE_BPS: 100,
  STALENESS_SECS: 60,
  MIN_DEBT_RAW: 10_000_000n,
  MIN_P_THRESHOLD: 1_000_000_000n,
  D_DECIMALS: 8,
  APT_DECIMALS: 8,
} as const;

// DeSNet v0.3.3 — monolith package on Aptos mainnet (18 Move modules
// at one address). Factory + governance + verbs all live under @desnet.
// Multisig publisher @origin = 0x000073c4... (1/5, raise to 3/5 pending).
export const DESNET_PACKAGE =
  "0x7ba7ee5a93694aa5943f4ef344737d95795d51395e3d65a1b732c776d34be724";
export const DESNET_ORIGIN_MULTISIG =
  "0x000073c4dd3fa51260b4cd8b6878191214df1e6dcd4dbcd1ed906c05c3aaa9a9";

// DESNET protocol token — registered as the `desnet` handle. The PID
// NFT, the FA metadata, and the AMM/staking/vault objects spun out at
// register_handle time. Pinned here so the DESNET shortcut on Page 1
// loads without an extra view round-trip.
export const DESNET_PID_NFT =
  "0xfa4dd0513a60afe94e9dcafda75e50072ef9718b14b8a91a731f2d04d9fc3adf";
export const DESNET_FA =
  "0x44c1006d4d8dae79195fa396c71408514343a5c4b4627b6e7595f64d65b224e7";
export const DESNET_AMM_POOL =
  "0x5ba92cb1c4eb871b36eb4475b85763c390f8aa604946eb1ea26c10ee46c822a8";
export const DESNET_LP_STAKING_POOL =
  "0x983d04dd23cdaa139af36e79af464739e6ec9f13874c2f6dc329ee508389481b";
export const DESNET_LP_EMISSION_RESERVE =
  "0x19c83d5de114c22ca462029c1ec5069d3c9c3aaec7a8028aefb4a41942e1088b";
export const DESNET_REACTION_EMISSION_RESERVE =
  "0x4d7544844fa9b6eea0a2720b434627986fc7adc0339d39b851824a892be44e23";
export const DESNET_APT_VAULT =
  "0xfd45ced87cc95c4a9f2bba5c633b357d748d0b03071e19ff2b66529104774d09";

// First opinion market on mainnet — "Make Aptos Great Again" by the desnet
// handle (PID owner @origin). seq=1, seeded with 25M DESNET. Lives at the
// deterministic address derived from (DESNET_PID_NFT, seq=1).
export const DESNET_FIRST_OPINION_MARKET =
  "0xc3ee69681fe46af7d82480c96b1cc4a598f960aa94f8994d003d6463a5092dac";

// AMM swap fee, hardcoded in amm.move. 10 bps, 100% to LP. Distinct
// from POOL_FEE_BPS (which is darbitex AMM, 5 bps).
export const DESNET_AMM_FEE_BPS = 10;
// Opinion-market trade tax — 0.1% of spot-equivalent $creator_token,
// burned via apt_vault::burn_via_vault on every deposit/swap/redeem.
// Hardcoded in opinion.move::DEFAULT_TAX_BPS.
export const DESNET_OPINION_TAX_BPS = 10;

// Length-tier handle pricing in APT octas. Mirrors the constants in
// profile.move::handle_fee_apt. Plus a 5 APT pool seed (octas) added on
// top by factory::pool_seed_apt_amount and withdrawn separately during
// register_handle. Both must be available in the wallet primary store.
export const DESNET_HANDLE_FEE_OCTAS: Record<number, bigint> = {
  1: 10_000_000_000n, // 100 APT
  2: 5_000_000_000n,  //  50 APT
  3: 2_000_000_000n,  //  20 APT
  4: 1_000_000_000n,  //  10 APT
  5: 500_000_000n,    //   5 APT
  6: 100_000_000n,    //   1 APT
};
export const DESNET_POOL_SEED_OCTAS = 500_000_000n; // 5 APT
export const DESNET_HANDLE_MAX_LEN = 64;

// Per-handle limits sourced from profile.move + mint.move. Avatar is
// inline base64 stored on the Profile resource; bio + content text are
// stored as on-chain UTF-8 strings; inline media (≤ 8 KB) lives in the
// Mint payload itself, anything larger goes through desnet::assets.
export const DESNET_AVATAR_MAX_BYTES = 8 * 1024;
export const DESNET_BIO_MAX_BYTES = 333;
export const DESNET_CONTENT_TEXT_MAX_BYTES = 333;
export const DESNET_INLINE_MEDIA_MAX_BYTES = 8 * 1024;

// Hardcoded Move constant in arbitrage.move. 3-of-5 multisig.
export const TREASURY =
  "0xdbce89113a975826028236f910668c3ff99c8db8981be6a448caa2f8836f9576";

// TREASURY_BPS = 1_000 (10%) on measurable surplus — hardcoded on-chain.
export const TREASURY_BPS = 1000;

// LP fee on the x*y=k pool primitive. 5 bps. 100% to LPs; no passive slot.
export const POOL_FEE_BPS = 5;

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
  D: {
    meta: "0x9015d5a6bbca103bc821a745a7fd3eb2ee1e535d3af65ac9fb4c7d308355c390",
    decimals: 8,
    symbol: "D",
    icon: "/tokens/one.svg",
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
  USD1: {
    meta: "0x31ac2b889a89053be7d9afde9044a70522e8916bb0f0f5e8abda51db3dda2bee",
    decimals: 6,
    symbol: "USD1",
    icon: "/tokens/usd1.png",
  },
  DARBITEX: {
    meta: "0x8241d225df6dee465b2898686011c477d5863abccae16630c7145c3165e9c2d",
    decimals: 8,
    symbol: "DARBITEX",
    icon: "/tokens/darbitex.svg",
  },
  DESNET: {
    meta: "0x44c1006d4d8dae79195fa396c71408514343a5c4b4627b6e7595f64d65b224e7",
    decimals: 8,
    symbol: "DESNET",
    icon: "/tokens/desnet.svg",
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
