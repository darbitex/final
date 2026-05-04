import { useEffect, useState } from "react";
import { fetchFaBalance } from "../../chain/balance";
import { tokenReserves } from "../../chain/desnet/amm";
import { createRpcPool, fromRaw } from "../../chain/rpc-pool";
import { useAptPriceUsd, formatUsd } from "../../chain/prices";
import { DESNET_PACKAGE, DESNET_PID_NFT } from "../../config";

const rpc = createRpcPool("desnet-pool-stats");

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
        const recs = await tokenReserves(rpc, handle);
        const [lpBal, rxBal, opVaultBal, currentSupplyRaw] = await Promise.all([
          fetchFaBalance(recs.lp_reserve, tokenMeta),
          fetchFaBalance(recs.reaction_reserve, tokenMeta),
          handle === "desnet"
            ? fetch("https://fullnode.mainnet.aptoslabs.com/v1/view", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  function: `${DESNET_PACKAGE}::opinion::vault_balance`,
                  type_arguments: [],
                  arguments: [DESNET_PID_NFT, "1"],
                }),
              })
                .then((r) => r.json())
                .then((arr: string[]) => BigInt(arr?.[0] ?? "0"))
                .catch(() => 0n)
            : Promise.resolve(0n),
          fetch("https://fullnode.mainnet.aptoslabs.com/v1/view", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              function: "0x1::fungible_asset::supply",
              type_arguments: ["0x1::fungible_asset::Metadata"],
              arguments: [tokenMeta],
            }),
          })
            .then((r) => r.json())
            .then((arr: Array<{ vec: string[] } | null>) => {
              const v = arr?.[0]?.vec?.[0];
              return v ? BigInt(v) : 0n;
            })
            .catch(() => 0n),
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
