import type { TokenConfig } from "../../config";

// Shared venue-adapter contract. Every external DEX (Thala, Hyperion,
// Cellana, future) exposes the same interface so the Aggregator page
// can iterate over them uniformly. Keeps the page logic venue-agnostic
// and lets us add a new venue by dropping in one more adapter file.

export type VenueQuote = {
  venue: string; // display label, e.g. "Thala"
  amountOutRaw: bigint;
  poolAddr?: string; // for display / explorer link
  route?: string[]; // multi-hop description, optional
  error?: string;
};

// Input to the adapter's buildSwapTx. Execution context the caller has
// already computed (amount, min_out, deadline).
export type VenueSwapParams = {
  tokenIn: TokenConfig;
  tokenOut: TokenConfig;
  amountInRaw: bigint;
  minOutRaw: bigint;
  deadlineSecs: number;
  quote: VenueQuote; // the quote the user is executing against
};

// Wallet transaction payload that the adapter hands back for
// signAndSubmitTransaction. Shape matches ts-sdk v6's InputEntryFunctionData.
export type VenueTxPayload = {
  function: `${string}::${string}::${string}`;
  typeArguments: string[];
  functionArguments: unknown[];
};

export type VenueAdapter = {
  // Short, stable identifier used as React list key.
  id: string;
  // Human label shown in the venue-table.
  label: string;
  // Called once per page mount to warm any runtime registries (pool
  // metadata, pool asset mappings, etc). Failure here must NOT crash
  // the page — adapters should swallow and mark themselves inactive.
  warmup?: () => Promise<void>;
  // Core quote entry point. Must resolve to null for "no route" so the
  // Aggregator can distinguish "no pool" from "errored".
  quote: (
    tokenIn: TokenConfig,
    tokenOut: TokenConfig,
    amountInRaw: bigint,
  ) => Promise<VenueQuote | null>;
  // Build the wallet-facing entry-function payload for executing a swap
  // against this venue. The Aggregator hands the returned payload
  // directly to signAndSubmitTransaction.
  buildSwapTx: (params: VenueSwapParams) => VenueTxPayload;
};
