import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useAddress } from "../../wallet/useConnect";
import { useFaBalance } from "../../chain/balance";
import { createRpcPool, fromRaw, toRaw } from "../../chain/rpc-pool";
import { DESNET_FA, DESNET_PACKAGE, TOKENS } from "../../config";
import { useSlippage } from "../../chain/slippage";
import {
  computeAmountOut,
  reserves,
  tokenMetadataAddr,
} from "../../chain/desnet/amm";
import { PoolStatsPanel } from "../../components/desnet/PoolStatsPanel";
import {
  handleBytes,
  isHandleRegistered,
  validateHandle,
} from "../../chain/desnet/profile";
import { APT_VIEW, useTokenView } from "../../chain/desnet/tokenIcon";
import { TokenIcon } from "../../components/TokenIcon";
import { formatNumberForInput } from "../../chain/desnet/format";
import { formatUsd, useAptPriceUsd, usdValueOf } from "../../chain/prices";

const APT = TOKENS.APT;
const rpc = createRpcPool("desnet-swap");

const SWAP_APT_FOR_TOKEN_FN = `${DESNET_PACKAGE}::amm::swap_apt_for_token`;
const SWAP_TOKEN_FOR_APT_FN = `${DESNET_PACKAGE}::amm::swap_token_for_apt`;

const HANDLE_DEBOUNCE_MS = 350;

export function Swap() {
  const address = useAddress();
  const { signAndSubmitTransaction, connected } = useWallet();
  const aptPrice = useAptPriceUsd();
  const [slippage] = useSlippage();

  const [handle, setHandle] = useState("desnet");
  const [resolvedHandle, setResolvedHandle] = useState<string | null>("desnet");
  // Pre-seed with DESNET_FA so the token icon resolves on first paint
  // without waiting on the debounced view round-trip.
  const [tokenMeta, setTokenMeta] = useState<string | null>(DESNET_FA);
  const [tokenSymbol, setTokenSymbol] = useState<string>("DESNET");
  const [poolReserves, setPoolReserves] = useState<{ apt: bigint; token: bigint } | null>(null);

  const [aptToToken, setAptToToken] = useState(true);
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const aptBal = useFaBalance(APT.meta, APT.decimals);
  const tokenBal = useFaBalance(tokenMeta, 8);
  const tokenView = useTokenView(tokenMeta);

  const handleErr = useMemo(() => (handle ? validateHandle(handle) : null), [handle]);

  // Resolve handle → tokenMeta + reserves whenever the handle stabilises.
  useEffect(() => {
    setResolvedHandle(null);
    // Don't null tokenMeta here — keeping the prior value avoids a
    // visible icon flicker while the debounce + view round-trip lands.
    setPoolReserves(null);
    if (!handle || handleErr) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const taken = await isHandleRegistered(rpc, handle);
        if (!taken) {
          if (!cancelled) setError(`@${handle} is not registered`);
          return;
        }
        const meta = await tokenMetadataAddr(rpc, handle);
        if (cancelled) return;
        setTokenMeta(meta);
        setTokenSymbol(handle.toUpperCase());
        setResolvedHandle(handle);
        setError(null);
        const [aR, tR] = await reserves(rpc, handle);
        if (!cancelled) setPoolReserves({ apt: aR, token: tR });
        // Supply / locked / burned breakdown is fetched inside PoolStatsPanel.
      } catch (e) {
        if (!cancelled) setError((e as Error).message ?? String(e));
      }
    }, HANDLE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [handle, handleErr]);

  const amountInRaw = useMemo(() => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return 0n;
    return toRaw(n, 8); // both sides use 8 decimals
  }, [amount]);

  const amountOutRaw = useMemo(() => {
    if (!poolReserves || amountInRaw <= 0n) return 0n;
    if (aptToToken) return computeAmountOut(poolReserves.apt, poolReserves.token, amountInRaw);
    return computeAmountOut(poolReserves.token, poolReserves.apt, amountInRaw);
  }, [poolReserves, amountInRaw, aptToToken]);

  const minOutRaw = useMemo(() => {
    if (amountOutRaw <= 0n) return 0n;
    const denom = 10_000n;
    const slip = BigInt(Math.round(slippage * Number(denom)));
    return (amountOutRaw * (denom - slip)) / denom;
  }, [amountOutRaw, slippage]);

  const fromBal = aptToToken ? aptBal : tokenBal;
  const toBal = aptToToken ? tokenBal : aptBal;
  const insufficient = fromBal.raw < amountInRaw;
  const inSymbol = aptToToken ? "APT" : `$${tokenSymbol}`;
  const outSymbol = aptToToken ? `$${tokenSymbol}` : "APT";
  const inView = aptToToken ? APT_VIEW : tokenView;
  const outView = aptToToken ? tokenView : APT_VIEW;
  const outFormatted = amountOutRaw > 0n ? Number(fromRaw(amountOutRaw, 8)).toFixed(6) : "";

  // USD display only available for APT side (price feed)
  const inUsd = aptToToken ? usdValueOf(Number(amount), "APT", aptPrice) : null;
  const outUsd = !aptToToken && amountOutRaw > 0n
    ? usdValueOf(Number(fromRaw(amountOutRaw, 8)), "APT", aptPrice)
    : null;

  // Spot rate from reserves (zero-input price), used by the bottom quote-box
  // for price-impact calc. The full pool stats / MC / FDV / supply breakdown
  // is inside <PoolStatsPanel/>.
  const spotTokenPerApt = useMemo(() => {
    if (!poolReserves || poolReserves.apt === 0n) return null;
    return Number(poolReserves.token) / Number(poolReserves.apt);
  }, [poolReserves]);
  const spotAptPerToken = useMemo(() => {
    if (spotTokenPerApt === null || spotTokenPerApt === 0) return null;
    return 1 / spotTokenPerApt;
  }, [spotTokenPerApt]);

  const effectiveOutPerIn = useMemo(() => {
    if (amountInRaw <= 0n || amountOutRaw <= 0n) return null;
    const aIn = Number(fromRaw(amountInRaw, 8));
    const aOut = Number(fromRaw(amountOutRaw, 8));
    if (aIn <= 0) return null;
    return aOut / aIn;
  }, [amountInRaw, amountOutRaw]);
  const spotOutPerIn = aptToToken ? spotTokenPerApt : spotAptPerToken;
  const priceImpactBps = useMemo(() => {
    if (spotOutPerIn === null || effectiveOutPerIn === null || spotOutPerIn === 0) return null;
    return Math.round(((spotOutPerIn - effectiveOutPerIn) / spotOutPerIn) * 10_000);
  }, [spotOutPerIn, effectiveOutPerIn]);
  const lpFeeIn = useMemo(() => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return null;
    return (n * 10) / 10_000; // 10 bps, all on input side
  }, [amount]);

  async function submit() {
    if (!resolvedHandle || amountInRaw <= 0n) return;
    setError(null);
    setLastTx(null);
    setSubmitting(true);
    try {
      const fn = aptToToken ? SWAP_APT_FOR_TOKEN_FN : SWAP_TOKEN_FOR_APT_FN;
      const result = await signAndSubmitTransaction({
        data: {
          function: fn,
          typeArguments: [],
          functionArguments: [
            handleBytes(resolvedHandle),
            amountInRaw.toString(),
            minOutRaw.toString(),
          ],
        },
      });
      setLastTx(result.hash);
      setAmount("");
      aptBal.refresh();
      tokenBal.refresh();
      const [aR, tR] = await reserves(rpc, resolvedHandle);
      setPoolReserves({ apt: aR, token: tR });
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit =
    !!address && !!resolvedHandle && amountInRaw > 0n && !insufficient && !submitting;

  function fmtRate(n: number | null, digits: number = 6): string {
    if (n === null || !Number.isFinite(n)) return "—";
    if (n === 0) return "0";
    if (n >= 1_000_000) return n.toExponential(3);
    if (n < 0.000001) return n.toExponential(3);
    return n.toFixed(digits);
  }
  function impactColor(bps: number | null): string {
    if (bps === null) return "";
    if (bps < 30) return "good";
    if (bps < 100) return "warn";
    return "bad";
  }

  return (
    <>
      <h2 className="page-title">
        Swap APT ↔ <span style={{ display: "inline-flex", alignItems: "center", gap: 6, verticalAlign: "middle" }}>
          <TokenIcon token={tokenView} size={22} />
          ${tokenSymbol}
        </span>
      </h2>
      <p className="page-sub">
        Per-handle AMM. 10 bps fee, 100% to LP.
      </p>

      <div className="swap-card">
        {/* Handle picker — similar to Darbitex Trade's "venue" selector */}
        <div className="swap-row">
          <label>Token (DeSNet handle)</label>
          <div className="swap-input">
            <input
              value={handle}
              onChange={(e) => setHandle(e.target.value.toLowerCase().trim())}
              placeholder="desnet"
              style={{ flex: 1 }}
            />
            <span className="token-select-with-icon">
              <TokenIcon token={tokenView} size={18} />
              <span className="token-select" style={{ fontWeight: 600 }}>
                ${tokenSymbol}
              </span>
            </span>
          </div>
          {handleErr && <small className="error">{handleErr}</small>}
        </div>

        <PoolStatsPanel
          handle={resolvedHandle}
          tokenMeta={tokenMeta}
          tokenSymbol={tokenSymbol}
          poolReserves={poolReserves}
        />

        {/* Input row */}
        <div className="swap-row">
          <label>From</label>
          <div className="swap-input">
            <input
              type="number"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.0"
              min="0"
              step="any"
            />
            <span className="token-select-with-icon">
              <TokenIcon token={inView} size={18} />
              <span className="token-select" style={{ fontWeight: 600 }}>
                {inSymbol}
              </span>
            </span>
          </div>
          {inUsd !== null && (
            <div className="usd-value">≈ {formatUsd(inUsd)}</div>
          )}
          {connected && (
            <button
              type="button"
              className="bal-link"
              onClick={() => fromBal.raw > 0n && setAmount(formatNumberForInput(fromBal.formatted))}
              disabled={fromBal.raw === 0n}
            >
              Balance: {fromBal.loading ? "…" : fromBal.formatted.toFixed(6)} {inSymbol}
            </button>
          )}
        </div>

        {/* Flip button — visual divider between input/output */}
        <div style={{ display: "flex", justifyContent: "center", margin: "4px 0" }}>
          <button
            type="button"
            className="link"
            onClick={() => setAptToToken((v) => !v)}
            aria-label="Flip swap direction"
            style={{
              padding: "4px 10px",
              borderRadius: 12,
              border: "1px solid #444",
              background: "#0a0a0a",
            }}
            title="Flip direction"
          >
            ↕
          </button>
        </div>

        {/* Output row */}
        <div className="swap-row">
          <label>To (estimated)</label>
          <div className="swap-input">
            <input
              type="text"
              readOnly
              value={outFormatted}
              placeholder="0.0"
            />
            <span className="token-select-with-icon">
              <TokenIcon token={outView} size={18} />
              <span className="token-select" style={{ fontWeight: 600 }}>
                {outSymbol}
              </span>
            </span>
          </div>
          {outUsd !== null && (
            <div className="usd-value">≈ {formatUsd(outUsd)}</div>
          )}
          {connected && (
            <div className="bal-static">
              Balance: {toBal.loading ? "…" : toBal.formatted.toFixed(6)} {outSymbol}
            </div>
          )}
        </div>
      </div>

      {amountInRaw > 0n && poolReserves && (
        <div className="quote-box" style={{ marginTop: 12 }}>
          <div className="quote-row">
            <span className="dim">Spot rate</span>
            <span>
              {spotOutPerIn === null
                ? "—"
                : `1 ${inSymbol} = ${fmtRate(spotOutPerIn)} ${outSymbol}`}
            </span>
          </div>
          <div className="quote-row">
            <span className="dim">Effective rate</span>
            <span>
              {effectiveOutPerIn === null
                ? "—"
                : `1 ${inSymbol} = ${fmtRate(effectiveOutPerIn)} ${outSymbol}`}
            </span>
          </div>
          <div className="quote-row">
            <span className="dim">Price impact</span>
            <span className={`impact-${impactColor(priceImpactBps)}`}>
              {priceImpactBps === null ? "—" : `${(priceImpactBps / 100).toFixed(2)}%`}
            </span>
          </div>
          <div className="quote-row">
            <span className="dim">LP fee (10 bps)</span>
            <span>{lpFeeIn === null ? "—" : `${fmtRate(lpFeeIn)} ${inSymbol}`}</span>
          </div>
          <div className="quote-row">
            <span className="dim">Slippage tolerance</span>
            <span>{(slippage * 100).toFixed(2)}%</span>
          </div>
          <div className="quote-row">
            <span className="dim">Min received</span>
            <span>
              {minOutRaw === 0n
                ? "—"
                : `${Number(fromRaw(minOutRaw, 8)).toFixed(6)} ${outSymbol}`}
            </span>
          </div>
        </div>
      )}

      {!address && <p className="muted" style={{ marginTop: 12 }}>Connect a wallet to swap.</p>}
      {address && insufficient && amountInRaw > 0n && (
        <p className="error" style={{ marginTop: 12 }}>Insufficient {inSymbol} balance.</p>
      )}

      <button
        className="primary"
        disabled={!canSubmit}
        onClick={submit}
        style={{ marginTop: 12, width: "100%", padding: "12px" }}
      >
        {submitting ? "Swapping…" : `Swap ${inSymbol} → ${outSymbol}`}
      </button>

      {lastTx && (
        <p className="ok" style={{ marginTop: 8 }}>
          Sent.{" "}
          <a
            href={`https://explorer.aptoslabs.com/txn/${lastTx}?network=mainnet`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {lastTx.slice(0, 10)}…
          </a>
        </p>
      )}
      {error && <p className="error" style={{ marginTop: 8 }}>{error}</p>}
    </>
  );
}
