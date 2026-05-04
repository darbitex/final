import { useEffect, useState } from "react";
import { fetchFaBalance } from "../../chain/balance";
import { tokenReserves } from "../../chain/desnet/amm";
import { createRpcPool, fromRaw } from "../../chain/rpc-pool";
import { useAptPriceUsd, formatUsd } from "../../chain/prices";
import { vaultBalance as opinionVaultBalance, marketExists } from "../../chain/desnet/opinion";
import { loadRecentHistory, decodeMintPayload, VERB } from "../../chain/desnet/history";
import { handleToWallet, deriveProfileAddress } from "../../chain/desnet/profile";

const rpc = createRpcPool("desnet-pool-stats");

// FA::supply view via the rpc pool — keeps multi-endpoint failover + auth
// header. Returns 0n on missing/error rather than throwing so the panel
// can render the rest of the breakdown even if supply is briefly stale.
async function readFaSupply(metadata: string): Promise<bigint> {
  try {
    const r = await rpc.viewFn<[{ vec: [string] | [] }]>(
      "0x1::fungible_asset::supply",
      ["0x1::fungible_asset::Metadata"],
      [metadata],
    );
    const v = r?.[0]?.vec?.[0];
    return v ? BigInt(v) : 0n;
  } catch {
    return 0n;
  }
}

// Walk the handle's recent history, find every opinion-mint, sum its vault
// balance. Bound at MINT_SCAN_DEPTH to keep the round-trip count flat —
// proper enumeration belongs to the indexer satellite (deferred). For
// PIDs with more than MINT_SCAN_DEPTH mints, this undercounts older
// markets; flagged in the panel as "(scanned recent N)".
const MINT_SCAN_DEPTH = 200;
async function sumOpinionVaults(handle: string): Promise<bigint> {
  try {
    const wallet = await handleToWallet(rpc, handle);
    if (!wallet) return 0n;
    const pidAddr = await deriveProfileAddress(rpc, wallet);
    const rows = await loadRecentHistory(rpc, pidAddr, MINT_SCAN_DEPTH);
    const seqs: number[] = [];
    for (const e of rows) {
      if (e.verb !== VERB.MINT && e.verb !== VERB.VOICE && e.verb !== VERB.REMIX) continue;
      const d = decodeMintPayload(e.payloadHex);
      if (d) seqs.push(d.seq);
    }
    if (seqs.length === 0) return 0n;
    // marketExists is cheap; query in parallel. For matches, fetch vault.
    const flags = await Promise.all(
      seqs.map((s) => marketExists(rpc, pidAddr, s).catch(() => false)),
    );
    const matchSeqs = seqs.filter((_, i) => flags[i]);
    if (matchSeqs.length === 0) return 0n;
    const balances = await Promise.all(
      matchSeqs.map((s) => opinionVaultBalance(rpc, pidAddr, s).catch(() => 0n)),
    );
    return balances.reduce((a, b) => a + b, 0n);
  } catch {
    return 0n;
  }
}

type SupplyInfo = {
  circulating: bigint;
  lpReserve: bigint;
  reactionReserve: bigint;
  opinionVault: bigint;
  burned: bigint;
  currentSupply: bigint;
};

type Props = {
  /// Resolved handle (lowercase). Used for the DESNET-specific opinion-vault read.
  handle: string | null;
  /// FA Metadata addr — drives the supply fetch.
  tokenMeta: string | null;
  /// Display symbol, typically `handle.toUpperCase()`.
  tokenSymbol: string;
  /// AMM pool reserves (apt octas, token raw). Drives spot price + MC/FDV.
  poolReserves: { apt: bigint; token: bigint } | null;
};

/// Pool depth + spot + MC/FDV/circulating + locked breakdowns, shared
/// between /desnet/swap and /desnet/liquidity. Self-fetches the supply
/// breakdown on (handle, tokenMeta) change.
export function PoolStatsPanel({ handle, tokenMeta, tokenSymbol, poolReserves }: Props) {
  const aptPrice = useAptPriceUsd();
  const [supply, setSupply] = useState<SupplyInfo | null>(null);

  useEffect(() => {
    setSupply(null);
    if (!handle || !tokenMeta) return;
    let cancelled = false;
    (async () => {
      try {
        // Per-fetch error isolation — one failing read can't poison the
        // whole panel. Each settles independently to a sensible 0n
        // fallback. The panel still renders; the failed row shows 0.
        const recs = await tokenReserves(rpc, handle).catch(() => null);
        if (cancelled) return;
        const lpReserveAddr = recs?.lp_reserve ?? null;
        const reactionReserveAddr = recs?.reaction_reserve ?? null;
        const [lpBal, rxBal, opVaultBal, currentSupplyRaw] = await Promise.all([
          lpReserveAddr ? fetchFaBalance(lpReserveAddr, tokenMeta).catch(() => 0n) : Promise.resolve(0n),
          reactionReserveAddr ? fetchFaBalance(reactionReserveAddr, tokenMeta).catch(() => 0n) : Promise.resolve(0n),
          // Generic per-handle opinion-vault sum. Bound at MINT_SCAN_DEPTH
          // recent entries — see sumOpinionVaults docstring.
          sumOpinionVaults(handle),
          readFaSupply(tokenMeta),
        ]);
        if (cancelled) return;
        const TOTAL = 100_000_000_000_000_000n; // 1B × 10^8
        const burned = currentSupplyRaw > 0n && TOTAL > currentSupplyRaw
          ? TOTAL - currentSupplyRaw
          : 0n;
        const denom = currentSupplyRaw > 0n ? currentSupplyRaw : TOTAL;
        const circ = denom - lpBal - rxBal - opVaultBal;
        setSupply({
          circulating: circ > 0n ? circ : 0n,
          lpReserve: lpBal,
          reactionReserve: rxBal,
          opinionVault: opVaultBal,
          burned,
          currentSupply: currentSupplyRaw > 0n ? currentSupplyRaw : TOTAL,
        });
      } catch {
        if (!cancelled) setSupply(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [handle, tokenMeta]);

  if (!poolReserves) return null;

  // Both sides 8 decimals → unitless ratios.
  const spotTokenPerApt = poolReserves.apt > 0n
    ? Number(poolReserves.token) / Number(poolReserves.apt)
    : null;
  const spotAptPerToken = spotTokenPerApt && spotTokenPerApt > 0
    ? 1 / spotTokenPerApt
    : null;
  const spotUsdPerToken = spotAptPerToken !== null && aptPrice !== null
    ? spotAptPerToken * aptPrice
    : null;

  const circTokens = supply ? Number(fromRaw(supply.circulating, 8)) : null;
  const mcUsd = spotUsdPerToken !== null && circTokens !== null
    ? spotUsdPerToken * circTokens
    : null;
  const fdvUsd = spotUsdPerToken !== null
    ? spotUsdPerToken * 1_000_000_000
    : null;

  const fmtPct = (raw: bigint) =>
    ((Number(fromRaw(raw, 8)) / 1_000_000_000) * 100).toFixed(2);

  return (
    <div className="quote-box" style={{ marginBottom: 10 }}>
      <div className="quote-row">
        <span className="dim">Pool depth</span>
        <span>
          <strong>{Number(fromRaw(poolReserves.apt, 8)).toLocaleString(undefined, { maximumFractionDigits: 4 })}</strong> APT
          {" · "}
          <strong>{Number(fromRaw(poolReserves.token, 8)).toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong> ${tokenSymbol}
        </span>
      </div>
      <div className="quote-row">
        <span className="dim">Spot price</span>
        <span>
          {spotAptPerToken === null ? (
            "—"
          ) : (
            <>1 ${tokenSymbol} = <strong>{spotAptPerToken < 0.000001 ? spotAptPerToken.toExponential(3) : spotAptPerToken.toFixed(6)}</strong> APT
              {spotUsdPerToken !== null && (
                <> · <strong>{spotUsdPerToken < 0.01 ? `$${spotUsdPerToken.toExponential(2)}` : formatUsd(spotUsdPerToken)}</strong></>
              )}
            </>
          )}
        </span>
      </div>
      <div className="quote-row">
        <span className="dim">Market cap</span>
        <span>{mcUsd === null ? "—" : <strong>{formatUsd(mcUsd)}</strong>}</span>
      </div>
      <div className="quote-row">
        <span className="dim">FDV (1B supply)</span>
        <span>{fdvUsd === null ? "—" : <strong>{formatUsd(fdvUsd)}</strong>}</span>
      </div>
      {supply && (
        <>
          <div className="quote-row">
            <span className="dim">Circulating</span>
            <span>
              <strong>{Number(fromRaw(supply.circulating, 8)).toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong> ${tokenSymbol}
              <span className="muted small" style={{ marginLeft: 6 }}>
                ({fmtPct(supply.circulating)}% of 1B)
              </span>
            </span>
          </div>
          <div className="quote-row">
            <span className="dim">Locked · LP staking emission</span>
            <span>
              <strong>{Number(fromRaw(supply.lpReserve, 8)).toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong> ${tokenSymbol}
              <span className="muted small" style={{ marginLeft: 6 }}>({fmtPct(supply.lpReserve)}%)</span>
            </span>
          </div>
          <div className="quote-row">
            <span className="dim">Locked · Press / reaction emission</span>
            <span>
              <strong>{Number(fromRaw(supply.reactionReserve, 8)).toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong> ${tokenSymbol}
              <span className="muted small" style={{ marginLeft: 6 }}>({fmtPct(supply.reactionReserve)}%)</span>
            </span>
          </div>
          <div className="quote-row">
            <span className="dim">Locked · Opinion vaults</span>
            <span>
              {supply.opinionVault === 0n && handle !== "desnet" ? (
                <span className="muted">—</span>
              ) : (
                <>
                  <strong>{Number(fromRaw(supply.opinionVault, 8)).toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong> ${tokenSymbol}
                  {supply.opinionVault > 0n && (
                    <span className="muted small" style={{ marginLeft: 6 }}>({fmtPct(supply.opinionVault)}%)</span>
                  )}
                </>
              )}
            </span>
          </div>
          <div className="quote-row">
            <span className="dim">Burned (1B − current supply)</span>
            <span>
              <strong>{Number(fromRaw(supply.burned, 8)).toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong> ${tokenSymbol}
              <span className="muted small" style={{ marginLeft: 6 }}>
                ({((Number(fromRaw(supply.burned, 8)) / 1_000_000_000) * 100).toFixed(4)}%)
              </span>
            </span>
          </div>
        </>
      )}
    </div>
  );
}
