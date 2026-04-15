import { Network } from "@aptos-labs/ts-sdk";

// Darbitex Final v0.1.0 — LIVE on Aptos mainnet. Same address as the
// publisher multisig (3-of-5). Compatible upgrade policy during soak,
// flips to immutable after.
export const PACKAGE =
  "0xc988d39a4a27b26e1d659431a0c5828f3862c155d1c331386cd5974298dd78dd";

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
};

// On-chain verified FA metadata addresses (same as Beta — canonical
// across the Aptos ecosystem, not Darbitex-specific).
export const TOKENS: Record<string, TokenConfig> = {
  APT: {
    meta: "0x000000000000000000000000000000000000000000000000000000000000000a",
    decimals: 8,
    symbol: "APT",
  },
  USDC: {
    meta: "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b",
    decimals: 6,
    symbol: "USDC",
  },
  USDt: {
    meta: "0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b",
    decimals: 6,
    symbol: "USDt",
  },
  lzUSDC: {
    meta: "0x2b3be0a97a73c87ff62cbdd36837a9fb5bbd1d7f06a73b7ed62ec15c5326c1b8",
    decimals: 6,
    symbol: "lzUSDC",
  },
  lzUSDT: {
    meta: "0xe568e9322107a5c9ba4cbd05a630a5586aa73e744ada246c3efb0f4ce3e295f3",
    decimals: 6,
    symbol: "lzUSDT",
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
