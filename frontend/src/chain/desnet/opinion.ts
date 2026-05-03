// chain/desnet/opinion.ts — opinion pool client (v0.4 mainnet).
//
// Mirrors desnet::opinion. Pure x*y=k CPMM with creator-token-denominated
// vault, no LP fee in the curve, separate 0.1% creator-token tax burned via
// apt_vault::burn_via_vault.
//
// Conservation invariant (asserted on chain at every mutation):
//   vault_balance == fungible_asset::supply(YAY) == fungible_asset::supply(NAY)

import type { RpcPool } from "../rpc-pool";
import { DESNET_PACKAGE } from "../../config";
import type { MoveArg, MoveFn } from "./tx";
import { ZERO_ADDR, MEDIA_KIND_INLINE, MEDIA_KIND_NONE, type CreateMintInput } from "./mint";

const MOD = "opinion";

// ============ Constants (mirror opinion.move) ============

// initial_mc bounds in raw units (8 decimals). Whole-token range = [1M, 100M].
export const MIN_INITIAL_MC = 100_000_000_000_000n;     // 1M × 1e8
export const MAX_INITIAL_MC = 10_000_000_000_000_000n;  // 100M × 1e8
export const OPN_DECIMALS = 8;

// Per-PID anti-grief cap on total opinion-mints.
export const MAX_OPINIONS_PER_PID = 10_000;

// Tax bps. Hardcoded internal — UI shows it for transparency only.
export const DEFAULT_TAX_BPS = 10;     // 0.1%
export const MAX_TAX_BPS = 1000;       // 10% (defense ceiling)
export const BPS_DENOM = 10_000;

// Side discriminator for deposit_pick_side. MUST match opinion.move:70-72:
// SIDE_NONE=0 (event-payload only — swap/redeem have no side), SIDE_YAY=1, SIDE_NAY=2.
// Wrong values here → on-chain abort E_INVALID_SIDE=4 (deposit_pick_side asserts
// `side == SIDE_YAY || side == SIDE_NAY`).
export const SIDE_NONE = 0;
export const SIDE_YAY = 1;
export const SIDE_NAY = 2;

// Kind discriminator for OpinionAction events / history payloads.
// Mirror opinion.move:77-83 names exactly so indexers/UIs can switch on them.
export const KIND_CREATE = 0;
export const KIND_DEPOSIT = 1;
export const KIND_SWAP_YAY_FOR_NAY = 2;
export const KIND_SWAP_NAY_FOR_YAY = 3;
export const KIND_REDEEM = 4;
export const KIND_DEPOSIT_BALANCED = 5;

// Error code → label. Module abort errors come back via wallet adapter as
// `(module, code)`. Use this map only for opinion-module aborts.
export const OPINION_ERROR: Readonly<Record<number, string>> = {
  1: "content too long",
  2: "profile required",
  3: "market not found",
  4: "invalid side",
  5: "amount must be > 0",
  6: "pool inactive (zero reserve)",
  7: "slippage exceeded (min_out not met)",
  8: "conservation invariant broken",
  9: "insufficient vault collateral",
  10: "no factory token for this PID",
  11: "initial_mc out of [1M..100M] range",
  12: "tax_bps too high",
  13: "per-PID opinion cap reached (10K)",
  14: "zero output (extreme pool skew)",
  15: "tax exceeds amount",
  16: "tax_bps drift defense (rc4 L1)",
  17: "market already exists at this seq (rc4 L2)",
};

// ============ Function ids ============

export const CREATE_OPINION_MINT_FN = `${DESNET_PACKAGE}::mint::create_opinion_mint` as MoveFn;
export const DEPOSIT_PICK_SIDE_FN   = `${DESNET_PACKAGE}::${MOD}::deposit_pick_side` as MoveFn;
export const DEPOSIT_BALANCED_FN    = `${DESNET_PACKAGE}::${MOD}::deposit_balanced` as MoveFn;
export const SWAP_YAY_FOR_NAY_FN    = `${DESNET_PACKAGE}::${MOD}::swap_yay_for_nay` as MoveFn;
export const SWAP_NAY_FOR_YAY_FN    = `${DESNET_PACKAGE}::${MOD}::swap_nay_for_yay` as MoveFn;
export const REDEEM_COMPLETE_SET_FN = `${DESNET_PACKAGE}::${MOD}::redeem_complete_set` as MoveFn;

// ============ Entry-fn arg builders ============

// 24-arg create_opinion_mint = 23-arg create_mint + opinion_initial_mc.
export type CreateOpinionMintInput = CreateMintInput & {
  opinionInitialMc: bigint;     // raw units (will be string-encoded for u64)
};

export function buildCreateOpinionMintArgs(i: CreateOpinionMintInput): MoveArg[] {
  const contentBytes = Array.from(new TextEncoder().encode(i.contentText));
  const useAsset = !!i.assetMasterAddr;
  const inline = i.inline;
  const mediaKind = useAsset ? MEDIA_KIND_NONE : inline ? MEDIA_KIND_INLINE : MEDIA_KIND_NONE;
  const mediaMime = useAsset ? 0 : inline ? inline.mime : 0;
  const mediaInlineData = useAsset ? [] : inline ? Array.from(inline.bytes) : [];

  const parent = i.parent ?? null;
  const quote = i.quote ?? null;

  return [
    /* content_kind */ 0,
    /* content_text */ contentBytes,
    /* media_kind */ mediaKind,
    /* media_mime */ mediaMime,
    /* media_inline_data */ mediaInlineData,
    /* media_ref_backend */ 0,
    /* media_ref_blob_id */ [],
    /* media_ref_hash */ [],
    /* parent_author */ parent ? parent.author : ZERO_ADDR,
    /* parent_seq */ parent ? parent.seq.toString() : "0",
    /* parent_set */ !!parent,
    /* quote_author */ quote ? quote.author : ZERO_ADDR,
    /* quote_seq */ quote ? quote.seq.toString() : "0",
    /* quote_set */ !!quote,
    /* mentions */ i.mentions ?? [],
    /* tags */ (i.tags ?? []).map((t) => Array.from(new TextEncoder().encode(t))),
    /* tickers */ i.tickers ?? [],
    /* tip_recipients */ (i.tips ?? []).map((t) => t.recipient),
    /* tip_tokens */ (i.tips ?? []).map((t) => t.tokenMetadata),
    /* tip_amounts */ (i.tips ?? []).map((t) => t.amount.toString()),
    /* asset_master_addr */ i.assetMasterAddr ?? ZERO_ADDR,
    /* asset_master_set */ !!i.assetMasterAddr,
    /* opinion_initial_mc */ i.opinionInitialMc.toString(),
  ];
}

export function depositPickSideArgs(authorPid: string, seq: number, side: number, amount: bigint): MoveArg[] {
  return [authorPid, seq.toString(), side, amount.toString()];
}

export function depositBalancedArgs(authorPid: string, seq: number, amount: bigint): MoveArg[] {
  return [authorPid, seq.toString(), amount.toString()];
}

export function swapYayForNayArgs(authorPid: string, seq: number, amountIn: bigint, minOut: bigint): MoveArg[] {
  return [authorPid, seq.toString(), amountIn.toString(), minOut.toString()];
}

export function swapNayForYayArgs(authorPid: string, seq: number, amountIn: bigint, minOut: bigint): MoveArg[] {
  return [authorPid, seq.toString(), amountIn.toString(), minOut.toString()];
}

export function redeemCompleteSetArgs(authorPid: string, seq: number, amount: bigint): MoveArg[] {
  return [authorPid, seq.toString(), amount.toString()];
}

// ============ View-fn wrappers ============

export async function marketExists(rpc: RpcPool, authorPid: string, seq: number): Promise<boolean> {
  const r = await rpc.viewFn<[boolean]>(MOD + "::market_exists", [], [authorPid, seq.toString()], DESNET_PACKAGE);
  return !!r[0];
}

export async function marketAddrOf(rpc: RpcPool, authorPid: string, seq: number): Promise<string> {
  const r = await rpc.viewFn<[string]>(MOD + "::market_addr_of", [], [authorPid, seq.toString()], DESNET_PACKAGE);
  return r[0];
}

export type PoolReserves = { yay: bigint; nay: bigint };
export async function poolReserves(rpc: RpcPool, authorPid: string, seq: number): Promise<PoolReserves> {
  const r = await rpc.viewFn<[string, string]>(MOD + "::pool_reserves", [], [authorPid, seq.toString()], DESNET_PACKAGE);
  return { yay: BigInt(r[0]), nay: BigInt(r[1]) };
}

export async function vaultBalance(rpc: RpcPool, authorPid: string, seq: number): Promise<bigint> {
  const r = await rpc.viewFn<[string]>(MOD + "::vault_balance", [], [authorPid, seq.toString()], DESNET_PACKAGE);
  return BigInt(r[0]);
}

export type Supplies = { totalYay: bigint; totalNay: bigint };
export async function totalSupplies(rpc: RpcPool, authorPid: string, seq: number): Promise<Supplies> {
  const r = await rpc.viewFn<[string, string]>(MOD + "::total_supplies", [], [authorPid, seq.toString()], DESNET_PACKAGE);
  return { totalYay: BigInt(r[0]), totalNay: BigInt(r[1]) };
}

export type TokenAddrs = { yay: string; nay: string };
export async function tokenAddrs(rpc: RpcPool, authorPid: string, seq: number): Promise<TokenAddrs> {
  const r = await rpc.viewFn<[string, string]>(MOD + "::token_addrs", [], [authorPid, seq.toString()], DESNET_PACKAGE);
  return { yay: r[0], nay: r[1] };
}

export async function creatorTokenOf(rpc: RpcPool, authorPid: string, seq: number): Promise<string> {
  const r = await rpc.viewFn<[string]>(MOD + "::creator_token_of", [], [authorPid, seq.toString()], DESNET_PACKAGE);
  return r[0];
}

export async function creatorInitialMc(rpc: RpcPool, authorPid: string, seq: number): Promise<bigint> {
  const r = await rpc.viewFn<[string]>(MOD + "::creator_initial_mc", [], [authorPid, seq.toString()], DESNET_PACKAGE);
  return BigInt(r[0]);
}

export async function taxBpsOf(rpc: RpcPool, authorPid: string, seq: number): Promise<number> {
  const r = await rpc.viewFn<[string]>(MOD + "::tax_bps_of", [], [authorPid, seq.toString()], DESNET_PACKAGE);
  return Number(r[0]);
}

export async function isPoolActive(rpc: RpcPool, authorPid: string, seq: number): Promise<boolean> {
  const r = await rpc.viewFn<[boolean]>(MOD + "::is_pool_active", [], [authorPid, seq.toString()], DESNET_PACKAGE);
  return !!r[0];
}

// Spot price of 1 YAY/NAY in $creator_token raw units, scaled by 1e8.
export async function yayPriceToken1e8(rpc: RpcPool, authorPid: string, seq: number): Promise<bigint> {
  const r = await rpc.viewFn<[string]>(MOD + "::yay_price_token_1e8", [], [authorPid, seq.toString()], DESNET_PACKAGE);
  return BigInt(r[0]);
}

export async function nayPriceToken1e8(rpc: RpcPool, authorPid: string, seq: number): Promise<bigint> {
  const r = await rpc.viewFn<[string]>(MOD + "::nay_price_token_1e8", [], [authorPid, seq.toString()], DESNET_PACKAGE);
  return BigInt(r[0]);
}

export async function nextOpinionSeq(rpc: RpcPool, pidAddr: string): Promise<number> {
  const r = await rpc.viewFn<[string]>(MOD + "::next_seq", [], [pidAddr], DESNET_PACKAGE);
  return Number(r[0]);
}

export async function pidOpinionCount(rpc: RpcPool, pidAddr: string): Promise<number> {
  const r = await rpc.viewFn<[string]>(MOD + "::opinion_count", [], [pidAddr], DESNET_PACKAGE);
  return Number(r[0]);
}

// On-chain compute_amount_out — pure CPMM with NO LP fee. Tax is separate
// (creator-token burn via burn_tax). Use this to preview swap output.
export async function previewAmountOut(
  rpc: RpcPool,
  reserveIn: bigint,
  reserveOut: bigint,
  amountIn: bigint,
): Promise<bigint> {
  const r = await rpc.viewFn<[string]>(
    MOD + "::compute_amount_out",
    [],
    [reserveIn.toString(), reserveOut.toString(), amountIn.toString()],
    DESNET_PACKAGE,
  );
  return BigInt(r[0]);
}

// On-chain compute_tax — ceiling rounding (prevents zero-tax dust trades).
export async function previewTax(rpc: RpcPool, amount: bigint, taxBps: number): Promise<bigint> {
  const r = await rpc.viewFn<[string]>(
    MOD + "::compute_tax",
    [],
    [amount.toString(), taxBps.toString()],
    DESNET_PACKAGE,
  );
  return BigInt(r[0]);
}

// ============ Atomic balanced+swap script (1-tx pure-side exposure) ============
//
// Bundled Move script at /scripts/buy_one_sided.mv composes deposit_balanced
// + swap_<unwanted>_for_<wanted> in a single atomic tx. User commits `amount`
// $creator_token, ends with ~2× wanted side (vs deposit_pick_side which
// donates half to pool).

const BUY_ONE_SIDED_SCRIPT_URL = "/scripts/buy_one_sided.mv";

let _buyScriptCache: Promise<Uint8Array> | null = null;
export function loadBuyOneSidedScript(): Promise<Uint8Array> {
  if (_buyScriptCache) return _buyScriptCache;
  _buyScriptCache = (async () => {
    const r = await fetch(BUY_ONE_SIDED_SCRIPT_URL);
    if (!r.ok) {
      _buyScriptCache = null;
      throw new Error(`Failed to load buy_one_sided script bytecode: ${r.status}`);
    }
    return new Uint8Array(await r.arrayBuffer());
  })();
  return _buyScriptCache;
}

/**
 * Preview buy_one_sided side-effects against current pool state.
 * Returns the EXPECTED outcome and recommended min_swap_out (with slippage applied).
 *
 * Math:
 *   - Leg 1 (deposit_balanced): vault +amount, mint amount YAY + amount NAY
 *   - Leg 2 (swap unwanted → wanted): receives `swap_out` of wanted side
 *     where swap_out = compute_amount_out(unwanted_pool, wanted_pool, amount)
 *   - User end-state: amount + swap_out of wanted side (vs amount only via
 *     deposit_pick_side — savings = swap_out / amount × 100%)
 *
 * Tax math:
 *   - Leg 1 deposit tax = compute_tax(amount, tax_bps)
 *   - Leg 2 swap tax = compute_tax(spot_equiv(amount), tax_bps)
 *     where spot_equiv = amount × wanted_pool / (yay_pool + nay_pool)
 *   - Total = both burns from $creator_token (separate from amount itself)
 */
export type BuyOneSidedPreview = {
  /** Final wanted-side balance increase (raw). */
  wantedSideOut: bigint;
  /** Multiplier vs deposit_pick_side (e.g. 2.0 = 2x assets). */
  multiplier: number;
  /** Recommended slippage-adjusted floor for the swap leg. */
  minSwapOut: bigint;
  /** Tax on leg 1 (deposit_balanced), in $creator_token raw units. */
  depositTax: bigint;
  /** Tax on leg 2 (swap), in $creator_token raw units. */
  swapTax: bigint;
  /** Total $creator_token needed = amount + depositTax + swapTax. */
  totalCreatorTokenNeeded: bigint;
  /** Implied effective price per wanted-side token (in $creator_token). */
  effectivePricePerToken: number;
  /** Will the swap leg trigger E_ZERO_OUTPUT (out=0)? */
  zeroOutputRisk: boolean;
};

export function previewBuyOneSided(
  poolYay: bigint,
  poolNay: bigint,
  amount: bigint,
  pureYay: boolean,
  taxBps: number = DEFAULT_TAX_BPS,
  slipBps: number = 200, // 2% default slippage
): BuyOneSidedPreview {
  const wantedPool = pureYay ? poolYay : poolNay;
  const unwantedPool = pureYay ? poolNay : poolYay;

  // Leg 2 simulation: swap `amount` of unwanted → wanted.
  // Note: deposit_balanced bumps NEITHER pool (mints fresh, both to user).
  // So pool reserves at time of swap = current reserves (no shift from leg 1).
  const swapOut = computeAmountOutLocal(unwantedPool, wantedPool, amount);
  const minSwapOut = (swapOut * BigInt(10000 - slipBps)) / 10000n;
  const zeroOutputRisk = swapOut === 0n;

  const depositTax = computeTaxLocal(amount, taxBps);
  const denom = poolYay + poolNay;
  const spotEquiv = denom > 0n ? (amount * wantedPool) / denom : 0n;
  const swapTax = computeTaxLocal(spotEquiv, taxBps);
  const totalCreatorTokenNeeded = amount + depositTax + swapTax;

  const wantedSideOut = amount + swapOut;
  const multiplier = amount > 0n ? Number(wantedSideOut * 10000n / amount) / 10000 : 0;
  const effectivePricePerToken =
    wantedSideOut > 0n ? Number(totalCreatorTokenNeeded * 10000n / wantedSideOut) / 10000 : 0;

  return {
    wantedSideOut,
    multiplier,
    minSwapOut,
    depositTax,
    swapTax,
    totalCreatorTokenNeeded,
    effectivePricePerToken,
    zeroOutputRisk,
  };
}

// ============ Pure helpers (no RPC) ============

// Mirror compute_amount_out for instant preview (no RPC roundtrip).
// Pure x*y=k, no fee in the curve. Returns 0 if pool degenerate.
export function computeAmountOutLocal(reserveIn: bigint, reserveOut: bigint, amountIn: bigint): bigint {
  if (reserveIn === 0n || reserveOut === 0n || amountIn === 0n) return 0n;
  return (reserveOut * amountIn) / (reserveIn + amountIn);
}

// Mirror compute_tax — ceiling rounding.
export function computeTaxLocal(amount: bigint, taxBps: number): bigint {
  if (amount === 0n || taxBps === 0) return 0n;
  const num = amount * BigInt(taxBps);
  const denom = BigInt(BPS_DENOM);
  // ceiling: (num + denom - 1) / denom
  return (num + denom - 1n) / denom;
}

// Compose a market preview given pool reserves + pending swap input.
// Returns (amount_out, spot_token_equiv, tax) — useful for the Trade UI.
export function quoteSwap(
  reserveIn: bigint,
  reserveOut: bigint,
  amountIn: bigint,
  taxBps: number = DEFAULT_TAX_BPS,
): { amountOut: bigint; spotTokenEquiv: bigint; tax: bigint } {
  const amountOut = computeAmountOutLocal(reserveIn, reserveOut, amountIn);
  // Spot value of amount_in YAY (or NAY) = amount_in × out_reserve / (in_reserve + out_reserve).
  // Mirrors the rc2 D-M1 fix in opinion.move (swap_yay_for_nay line 586-587).
  const spotTokenEquiv =
    reserveIn + reserveOut === 0n
      ? 0n
      : (amountIn * reserveOut) / (reserveIn + reserveOut);
  const tax = computeTaxLocal(spotTokenEquiv, taxBps);
  return { amountOut, spotTokenEquiv, tax };
}

// Whole-token formatter for UI. Returns BigInt-safe string with ≤ N decimals.
//
// rc-frontend D-MED-1 fix: when truncating to maxFracDigits hides a non-zero
// fractional component (e.g. raw=100_000_001n with maxFracDigits=4 would
// display "1" instead of "1.00000001"), append a "<0.0001" indicator so users
// don't think their dust balance is exactly zero.
export function formatTokenAmount(raw: bigint, decimals = OPN_DECIMALS, maxFracDigits = 4): string {
  const denom = 10n ** BigInt(decimals);
  const whole = raw / denom;
  const frac = raw % denom;
  if (frac === 0n) return whole.toLocaleString();
  // Right-pad fraction to `decimals`, then trim to maxFracDigits, then strip trailing zeros.
  const fullFracStr = frac.toString().padStart(decimals, "0");
  let fracStr = fullFracStr.length > maxFracDigits ? fullFracStr.slice(0, maxFracDigits) : fullFracStr;
  fracStr = fracStr.replace(/0+$/, "");
  if (fracStr.length === 0) {
    // Fraction exists but truncated below display precision. Show a "+ε" hint
    // so the user knows the balance is not exactly the whole amount.
    return `${whole.toLocaleString()}+ε`;
  }
  return `${whole.toLocaleString()}.${fracStr}`;
}

// Validate initial_mc against the contract's [MIN..MAX] gate before user
// signs a tx that would otherwise abort E_INITIAL_MC_OUT_OF_RANGE=11.
export function validateInitialMc(raw: bigint): { ok: true } | { ok: false; reason: string } {
  if (raw < MIN_INITIAL_MC) return { ok: false, reason: `below MIN_INITIAL_MC (1M whole = ${MIN_INITIAL_MC} raw)` };
  if (raw > MAX_INITIAL_MC) return { ok: false, reason: `above MAX_INITIAL_MC (100M whole = ${MAX_INITIAL_MC} raw)` };
  return { ok: true };
}

// Convert a whole-token user input to raw u64. Truncates fractions beyond
// OPN_DECIMALS. Throws if the result overflows 2^64-1.
export function wholeToRaw(whole: number | string, decimals = OPN_DECIMALS): bigint {
  const s = typeof whole === "string" ? whole.trim() : whole.toString();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`invalid whole-token input: ${s}`);
  const [intPart, fracPart = ""] = s.split(".");
  const fracPadded = (fracPart + "0".repeat(decimals)).slice(0, decimals);
  const raw = BigInt(intPart) * 10n ** BigInt(decimals) + BigInt(fracPadded);
  if (raw > (1n << 64n) - 1n) throw new Error(`overflow: ${raw} > u64::MAX`);
  return raw;
}
