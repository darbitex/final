import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useEffect, useMemo, useState } from "react";
import { TOKENS, type TokenConfig } from "../config";
import {
  buildRunArbPayload,
  canonicalDarbitexPool,
  findThalaPoolsForPair,
  previewFlashbotCycle,
  type FlashbotPreview,
} from "../chain/flashbot";
import { formatUsd, useAptPriceUsd, usdValueOf } from "../chain/prices";
import { fromRaw, toRaw } from "../chain/rpc-pool";
import { useSlippage } from "../chain/slippage";
import { useAddress } from "../wallet/useConnect";

// Cross-venue flash-arb panel — wires the Arbitrage page to the
// darbitex-flashbot satellite. Flow:
//   1. User picks borrow asset + size + other asset
//   2. Frontend auto-resolves Darbitex canonical pool + Thala
//      candidate pools that match the pair (from the seed registry)
//   3. On scan, previews both cycle directions via on-chain view
//      calls, picks the profitable winner
//   4. On execute, submits `flashbot::run_arb` with the winning
//      direction + slippage-adjusted min_net_profit floor
//
// All profit distribution math (90% caller / 10% treasury) is a
// hardcoded Move constant on the satellite — the frontend just
// displays the split and passes the caller-share floor through
// as `min_net_profit`.
export function FlashbotPanel() {
  const { signAndSubmitTransaction } = useWallet();
  const address = useAddress();
  const [slippage] = useSlippage();
  const aptPrice = useAptPriceUsd();
  const tokenList = useMemo(() => Object.values(TOKENS), []);

  const [borrowAsset, setBorrowAsset] = useState<TokenConfig>(TOKENS.APT);
  const [otherAsset, setOtherAsset] = useState<TokenConfig>(TOKENS.USDC);
  const [amount, setAmount] = useState("");

  const [darbitexPool, setDarbitexPool] = useState<string | null>(null);
  const [poolLookupErr, setPoolLookupErr] = useState<string | null>(null);

  const [thalaCandidates, setThalaCandidates] = useState<string[]>([]);
  const [selectedThalaPool, setSelectedThalaPool] = useState<string | null>(null);

  const [scanning, setScanning] = useState(false);
  const [preview, setPreview] = useState<FlashbotPreview | null>(null);
  const [scanErr, setScanErr] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  // Re-resolve pools whenever the pair changes.
  useEffect(() => {
    if (borrowAsset.meta === otherAsset.meta) {
      setDarbitexPool(null);
      setThalaCandidates([]);
      setSelectedThalaPool(null);
      return;
    }
    let cancelled = false;
    setPoolLookupErr(null);
    (async () => {
      const [darb, thalaList] = await Promise.all([
        canonicalDarbitexPool(borrowAsset.meta, otherAsset.meta),
        findThalaPoolsForPair(borrowAsset.meta, otherAsset.meta),
      ]);
      if (cancelled) return;
      setDarbitexPool(darb);
      setThalaCandidates(thalaList);
      setSelectedThalaPool(thalaList[0] ?? null);
      if (!darb) setPoolLookupErr("No canonical Darbitex pool for this pair");
      else if (thalaList.length === 0) setPoolLookupErr("No matching Thala pool in the seed registry");
    })();
    return () => {
      cancelled = true;
    };
  }, [borrowAsset, otherAsset]);

  // Clear preview when any input changes.
  useEffect(() => {
    setPreview(null);
    setScanErr(null);
    setLastTx(null);
    setSubmitErr(null);
  }, [borrowAsset, otherAsset, amount, selectedThalaPool]);

  async function scan() {
    if (!darbitexPool || !selectedThalaPool) return;
    const numeric = Number(amount);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      setScanErr("Enter a positive amount");
      return;
    }
    setScanning(true);
    setScanErr(null);
    setPreview(null);
    try {
      const borrowAmountRaw = toRaw(numeric, borrowAsset.decimals);
      const result = await previewFlashbotCycle({
        borrowAsset,
        borrowAmountRaw,
        otherAsset,
        darbitexPool,
        thalaPool: selectedThalaPool,
      });
      setPreview(result);
    } catch (e) {
      setScanErr((e as Error).message);
    } finally {
      setScanning(false);
    }
  }

  async function execute() {
    if (!address || !preview || !preview.best || !darbitexPool || !selectedThalaPool) {
      return;
    }
    setSubmitting(true);
    setSubmitErr(null);
    setLastTx(null);
    try {
      const borrowAmountRaw = toRaw(Number(amount), borrowAsset.decimals);
      // Slippage floor — accept some reserve drift between preview and
      // execution. `min_net_profit` is compared against the caller share
      // on-chain, so we apply the slippage multiplier on that value.
      const slipBps = BigInt(Math.floor((1 - slippage) * 10_000));
      const minNetProfitRaw =
        (preview.best.preview.callerShare * slipBps) / 10_000n;
      const deadlineSecs = Math.floor(Date.now() / 1000) + 300;
      const payload = buildRunArbPayload({
        borrowAsset,
        borrowAmountRaw,
        otherAsset,
        darbitexSwapPool: darbitexPool,
        thalaSwapPool: selectedThalaPool,
        thalaFirst: preview.best.thalaFirst,
        minNetProfitRaw,
        deadlineSecs,
      });
      const result = await signAndSubmitTransaction({
        data: {
          function: payload.function as `${string}::${string}::${string}`,
          typeArguments: payload.typeArguments,
          functionArguments:
            payload.functionArguments as unknown as (string | boolean)[],
        },
      });
      setLastTx(result.hash);
    } catch (e) {
      setSubmitErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const borrowUsd = (() => {
    const n = Number(amount);
    return usdValueOf(n, borrowAsset.symbol, aptPrice);
  })();

  const callerShareFormatted = preview?.best
    ? fromRaw(preview.best.preview.callerShare, borrowAsset.decimals)
    : null;
  const treasuryShareFormatted = preview?.best
    ? fromRaw(preview.best.preview.treasuryShare, borrowAsset.decimals)
    : null;
  const callerShareUsd = callerShareFormatted !== null
    ? usdValueOf(callerShareFormatted, borrowAsset.symbol, aptPrice)
    : null;

  return (
    <div className="swap-card flashbot-panel">
      <h3 className="flashbot-title">Cross-venue flash arb (Darbitex × Thala)</h3>
      <p className="modal-note">
        Borrows from Aave (0 fee), swaps through Darbitex and Thala in whichever
        direction is profitable, repays the flash loan, and splits the
        residual <strong>90% to you</strong> and <strong>10% to the
        hardcoded Darbitex treasury</strong>. Powered by the{" "}
        <code>darbitex-flashbot</code> satellite.
      </p>

      <div className="swap-row">
        <label>Borrow asset</label>
        <select
          className="token-select full"
          value={borrowAsset.symbol}
          onChange={(e) => {
            const t = tokenList.find((x) => x.symbol === e.target.value);
            if (t) setBorrowAsset(t);
          }}
        >
          {tokenList.map((t) => (
            <option key={t.symbol} value={t.symbol}>
              {t.symbol}
            </option>
          ))}
        </select>
      </div>

      <div className="swap-row">
        <label>Borrow amount</label>
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.0"
          min="0"
        />
        {borrowUsd !== null && (
          <div className="usd-value">≈ {formatUsd(borrowUsd)}</div>
        )}
      </div>

      <div className="swap-row">
        <label>Other asset</label>
        <select
          className="token-select full"
          value={otherAsset.symbol}
          onChange={(e) => {
            const t = tokenList.find((x) => x.symbol === e.target.value);
            if (t) setOtherAsset(t);
          }}
        >
          {tokenList.map((t) => (
            <option key={t.symbol} value={t.symbol}>
              {t.symbol}
            </option>
          ))}
        </select>
      </div>

      {darbitexPool && (
        <div className="modal-note">
          <strong>Darbitex pool:</strong> {darbitexPool.slice(0, 12)}…
          {darbitexPool.slice(-6)}
        </div>
      )}

      {thalaCandidates.length > 1 ? (
        <div className="swap-row">
          <label>Thala pool ({thalaCandidates.length} candidates)</label>
          <select
            className="token-select full"
            value={selectedThalaPool ?? ""}
            onChange={(e) => setSelectedThalaPool(e.target.value)}
          >
            {thalaCandidates.map((p) => (
              <option key={p} value={p}>
                {p.slice(0, 12)}…{p.slice(-6)}
              </option>
            ))}
          </select>
        </div>
      ) : selectedThalaPool ? (
        <div className="modal-note">
          <strong>Thala pool:</strong> {selectedThalaPool.slice(0, 12)}…
          {selectedThalaPool.slice(-6)}
        </div>
      ) : null}

      {poolLookupErr && <div className="hint">{poolLookupErr}</div>}

      <button
        type="button"
        className="primary"
        onClick={scan}
        disabled={
          scanning || !amount || !darbitexPool || !selectedThalaPool || borrowAsset.meta === otherAsset.meta
        }
      >
        {scanning ? "Scanning both directions…" : "Scan profit"}
      </button>

      {scanErr && <div className="err">{scanErr}</div>}

      {preview && (
        <>
          <div className="venue-table">
            <div className="venue-head">
              <span>Direction</span>
              <span>Leg 1 → Leg 2</span>
              <span>Profit</span>
            </div>
            <DirectionRow
              label="Darbitex → Thala"
              row={preview.darbitexFirst}
              isBest={preview.best?.thalaFirst === false}
              borrowSymbol={borrowAsset.symbol}
              otherSymbol={otherAsset.symbol}
              borrowDecimals={borrowAsset.decimals}
              otherDecimals={otherAsset.decimals}
            />
            <DirectionRow
              label="Thala → Darbitex"
              row={preview.thalaFirst}
              isBest={preview.best?.thalaFirst === true}
              borrowSymbol={borrowAsset.symbol}
              otherSymbol={otherAsset.symbol}
              borrowDecimals={borrowAsset.decimals}
              otherDecimals={otherAsset.decimals}
            />
          </div>

          {preview.best ? (
            <div className="surplus-note">
              Best:{" "}
              <strong>{preview.best.thalaFirst ? "Thala → Darbitex" : "Darbitex → Thala"}</strong>
              {" · "}
              Your share (90%):{" "}
              <strong>
                {callerShareFormatted?.toFixed(6)} {borrowAsset.symbol}
              </strong>
              {callerShareUsd !== null && (
                <span className="usd-inline"> · {formatUsd(callerShareUsd)}</span>
              )}
              {" · "}
              Treasury (10%): {treasuryShareFormatted?.toFixed(6)}{" "}
              {borrowAsset.symbol}
            </div>
          ) : (
            <div className="surplus-note dim">
              Neither direction is profitable at this size. Try a different
              amount, pair, or Thala pool — or accept that the current pool
              reserves don't offer a cycle above the 1 bps LP + gas floor.
            </div>
          )}
        </>
      )}

      {submitErr && <div className="err">{submitErr}</div>}

      <button
        type="button"
        className="primary"
        onClick={execute}
        disabled={!address || !preview?.best || submitting}
      >
        {!address
          ? "Connect wallet"
          : submitting
            ? "Executing flash arb…"
            : "Execute cross-venue arb"}
      </button>

      {lastTx && (
        <div className="ok">
          Submitted:{" "}
          <a
            href={`https://explorer.aptoslabs.com/txn/${lastTx}?network=mainnet`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {lastTx.slice(0, 10)}…
          </a>
        </div>
      )}
    </div>
  );
}

function DirectionRow({
  label,
  row,
  isBest,
  borrowSymbol,
  otherSymbol,
  borrowDecimals,
  otherDecimals,
}: {
  label: string;
  row:
    | null
    | {
        leg1Out: bigint;
        leg2Out: bigint;
        profitTotal: bigint;
        profitable: boolean;
        callerShare: bigint;
      };
  isBest: boolean;
  borrowSymbol: string;
  otherSymbol: string;
  borrowDecimals: number;
  otherDecimals: number;
}) {
  if (!row) {
    return (
      <div className="venue-row">
        <span className="venue-name">{label}</span>
        <span className="venue-route">—</span>
        <span className="venue-out">no route</span>
      </div>
    );
  }
  const leg1 = fromRaw(row.leg1Out, otherDecimals);
  const leg2 = fromRaw(row.leg2Out, borrowDecimals);
  const profit = fromRaw(row.profitTotal, borrowDecimals);
  return (
    <div className={`venue-row ${isBest ? "best" : ""}`}>
      <span className="venue-name">{label}</span>
      <span className="venue-route">
        {leg1.toFixed(6)} {otherSymbol} → {leg2.toFixed(6)} {borrowSymbol}
      </span>
      <span className="venue-out">
        {row.profitable ? "+" : ""}
        {profit.toFixed(6)} {borrowSymbol}
      </span>
    </div>
  );
}
