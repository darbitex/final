import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useEffect, useMemo, useState } from "react";
import { TOKENS, type TokenConfig } from "../config";
import {
  buildRunArbCellanaPayload,
  buildRunArbHyperionPayload,
  buildRunArbPayload,
  canonicalDarbitexPool,
  findCellanaCurvesForPair,
  findHyperionPoolForPair,
  findThalaPoolsForPair,
  previewCellanaCycle,
  previewFlashbotCycle,
  previewHyperionCycle,
  type FlashbotPreview,
  type FlashbotVenue,
} from "../chain/flashbot";
import { formatUsd, useAptPriceUsd, usdValueOf } from "../chain/prices";
import { fromRaw, toRaw } from "../chain/rpc-pool";
import { useSlippage } from "../chain/slippage";
import { TokenIcon } from "./TokenIcon";
import { useAddress } from "../wallet/useConnect";

// Cross-venue flash-arb panel — wires the Arbitrage page to the
// darbitex-flashbot satellite. Supports three venue pairings:
//   - Darbitex × Thala V2           (`run_arb`)
//   - Darbitex × Hyperion CLMM      (`run_arb_hyperion`)
//   - Darbitex × Cellana (stable/volatile) (`run_arb_cellana`)
//
// User picks venue first, then the borrow pair + size; per-venue pool
// discovery runs on pair change. Preview compares both leg directions
// and the panel executes the winning direction with a slippage floor
// applied to the caller-share (post 90/10 split).
export function FlashbotPanel() {
  const { signAndSubmitTransaction } = useWallet();
  const address = useAddress();
  const [slippage] = useSlippage();
  const aptPrice = useAptPriceUsd();
  const tokenList = useMemo(() => Object.values(TOKENS), []);

  const [venue, setVenue] = useState<FlashbotVenue>("thala");
  const [borrowAsset, setBorrowAsset] = useState<TokenConfig>(TOKENS.APT);
  const [otherAsset, setOtherAsset] = useState<TokenConfig>(TOKENS.USDC);
  const [amount, setAmount] = useState("");

  const [darbitexPool, setDarbitexPool] = useState<string | null>(null);
  const [poolLookupErr, setPoolLookupErr] = useState<string | null>(null);

  // Thala: list of candidate pools; Hyperion: single pool; Cellana: curves.
  const [thalaCandidates, setThalaCandidates] = useState<string[]>([]);
  const [selectedThalaPool, setSelectedThalaPool] = useState<string | null>(null);
  const [hyperionPool, setHyperionPool] = useState<string | null>(null);
  const [cellanaCurves, setCellanaCurves] = useState<boolean[]>([]);
  const [selectedCellanaStable, setSelectedCellanaStable] = useState<boolean | null>(null);

  const [scanning, setScanning] = useState(false);
  const [preview, setPreview] = useState<FlashbotPreview | null>(null);
  const [scanErr, setScanErr] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  // Re-resolve pools whenever venue or pair changes.
  useEffect(() => {
    if (borrowAsset.meta === otherAsset.meta) {
      setDarbitexPool(null);
      setThalaCandidates([]);
      setSelectedThalaPool(null);
      setHyperionPool(null);
      setCellanaCurves([]);
      setSelectedCellanaStable(null);
      return;
    }
    let cancelled = false;
    setPoolLookupErr(null);
    (async () => {
      const darbP = canonicalDarbitexPool(borrowAsset.meta, otherAsset.meta);
      const venueP: Promise<unknown> =
        venue === "thala"
          ? findThalaPoolsForPair(borrowAsset.meta, otherAsset.meta)
          : venue === "hyperion"
            ? findHyperionPoolForPair(borrowAsset.meta, otherAsset.meta)
            : findCellanaCurvesForPair(borrowAsset.meta, otherAsset.meta);
      const [darb, venueRes] = await Promise.all([darbP, venueP]);
      if (cancelled) return;
      setDarbitexPool(darb);

      if (venue === "thala") {
        const list = venueRes as string[];
        setThalaCandidates(list);
        setSelectedThalaPool(list[0] ?? null);
        setHyperionPool(null);
        setCellanaCurves([]);
        setSelectedCellanaStable(null);
        if (!darb) setPoolLookupErr("No canonical Darbitex pool for this pair");
        else if (list.length === 0)
          setPoolLookupErr("No matching Thala pool in the seed registry");
      } else if (venue === "hyperion") {
        const pool = venueRes as string | null;
        setHyperionPool(pool);
        setThalaCandidates([]);
        setSelectedThalaPool(null);
        setCellanaCurves([]);
        setSelectedCellanaStable(null);
        if (!darb) setPoolLookupErr("No canonical Darbitex pool for this pair");
        else if (!pool) setPoolLookupErr("Hyperion has no pool for this pair at the active tier");
      } else {
        const curves = venueRes as boolean[];
        setCellanaCurves(curves);
        setSelectedCellanaStable(curves[0] ?? null);
        setThalaCandidates([]);
        setSelectedThalaPool(null);
        setHyperionPool(null);
        if (!darb) setPoolLookupErr("No canonical Darbitex pool for this pair");
        else if (curves.length === 0)
          setPoolLookupErr("Cellana doesn't route this pair on either curve");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [venue, borrowAsset, otherAsset]);

  // Clear preview when any input changes.
  useEffect(() => {
    setPreview(null);
    setScanErr(null);
    setLastTx(null);
    setSubmitErr(null);
  }, [venue, borrowAsset, otherAsset, amount, selectedThalaPool, hyperionPool, selectedCellanaStable]);

  async function scan() {
    if (!darbitexPool) return;
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
      let result: FlashbotPreview;
      if (venue === "thala") {
        if (!selectedThalaPool) return;
        result = await previewFlashbotCycle({
          borrowAsset,
          borrowAmountRaw,
          otherAsset,
          darbitexPool,
          thalaPool: selectedThalaPool,
        });
      } else if (venue === "hyperion") {
        if (!hyperionPool) return;
        result = await previewHyperionCycle({
          borrowAsset,
          borrowAmountRaw,
          otherAsset,
          darbitexPool,
          hyperionPool,
        });
      } else {
        if (selectedCellanaStable === null) return;
        result = await previewCellanaCycle({
          borrowAsset,
          borrowAmountRaw,
          otherAsset,
          darbitexPool,
          isStable: selectedCellanaStable,
        });
      }
      setPreview(result);
    } catch (e) {
      setScanErr((e as Error).message);
    } finally {
      setScanning(false);
    }
  }

  async function execute() {
    if (!address || !preview || !preview.best || !darbitexPool) return;
    setSubmitting(true);
    setSubmitErr(null);
    setLastTx(null);
    try {
      const borrowAmountRaw = toRaw(Number(amount), borrowAsset.decimals);
      const slipBps = BigInt(Math.floor((1 - slippage) * 10_000));
      const minNetProfitRaw =
        (preview.best.preview.callerShare * slipBps) / 10_000n;
      const deadlineSecs = Math.floor(Date.now() / 1000) + 300;
      // `preview.best.thalaFirst` is semantically "non-Darbitex venue first"
      // for all venues — field name kept for shape compatibility.
      const nonDarbitexFirst = preview.best.thalaFirst;

      let payload;
      if (venue === "thala") {
        if (!selectedThalaPool) return;
        payload = buildRunArbPayload({
          borrowAsset,
          borrowAmountRaw,
          otherAsset,
          darbitexSwapPool: darbitexPool,
          thalaSwapPool: selectedThalaPool,
          thalaFirst: nonDarbitexFirst,
          minNetProfitRaw,
          deadlineSecs,
        });
      } else if (venue === "hyperion") {
        if (!hyperionPool) return;
        payload = buildRunArbHyperionPayload({
          borrowAsset,
          borrowAmountRaw,
          otherAsset,
          darbitexSwapPool: darbitexPool,
          hyperionSwapPool: hyperionPool,
          hyperionFirst: nonDarbitexFirst,
          minNetProfitRaw,
          deadlineSecs,
        });
      } else {
        if (selectedCellanaStable === null) return;
        payload = buildRunArbCellanaPayload({
          borrowAsset,
          borrowAmountRaw,
          otherAsset,
          darbitexSwapPool: darbitexPool,
          isStable: selectedCellanaStable,
          cellanaFirst: nonDarbitexFirst,
          minNetProfitRaw,
          deadlineSecs,
        });
      }
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

  const venueLabel =
    venue === "thala" ? "Thala" : venue === "hyperion" ? "Hyperion" : "Cellana";
  const scanDisabled =
    scanning ||
    !amount ||
    !darbitexPool ||
    borrowAsset.meta === otherAsset.meta ||
    (venue === "thala" && !selectedThalaPool) ||
    (venue === "hyperion" && !hyperionPool) ||
    (venue === "cellana" && selectedCellanaStable === null);

  return (
    <div className="swap-card flashbot-panel">
      <h3 className="flashbot-title">Cross-venue flash arb (Darbitex × {venueLabel})</h3>
      <p className="modal-note">
        Borrows from Aave (0 fee), swaps through Darbitex and {venueLabel} in
        whichever direction is profitable, repays the flash loan, and splits the
        residual <strong>90% to you</strong> and <strong>10% to the hardcoded
        Darbitex treasury</strong>. Powered by the <code>darbitex-flashbot</code>{" "}
        satellite.
      </p>

      <div className="swap-row">
        <label>Venue</label>
        <div className="venue-picker">
          <button
            type="button"
            className={`btn ${venue === "thala" ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setVenue("thala")}
          >
            Thala V2
          </button>
          <button
            type="button"
            className={`btn ${venue === "hyperion" ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setVenue("hyperion")}
          >
            Hyperion CLMM
          </button>
          <button
            type="button"
            className={`btn ${venue === "cellana" ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setVenue("cellana")}
          >
            Cellana
          </button>
        </div>
      </div>

      <div className="swap-row">
        <label>Borrow asset</label>
        <span className="token-select-with-icon">
          <TokenIcon token={borrowAsset} size={18} />
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
        </span>
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
        <span className="token-select-with-icon">
          <TokenIcon token={otherAsset} size={18} />
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
        </span>
      </div>

      {darbitexPool && (
        <div className="modal-note">
          <strong>Darbitex pool:</strong> {darbitexPool.slice(0, 12)}…
          {darbitexPool.slice(-6)}
        </div>
      )}

      {venue === "thala" && thalaCandidates.length > 1 ? (
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
      ) : venue === "thala" && selectedThalaPool ? (
        <div className="modal-note">
          <strong>Thala pool:</strong> {selectedThalaPool.slice(0, 12)}…
          {selectedThalaPool.slice(-6)}
        </div>
      ) : null}

      {venue === "hyperion" && hyperionPool && (
        <div className="modal-note">
          <strong>Hyperion pool:</strong> {hyperionPool.slice(0, 12)}…
          {hyperionPool.slice(-6)} · tier {" "}
          {/* tier is global HYPERION_ACTIVE_TIER, shown as "1" (5 bps) */}
          5 bps
        </div>
      )}

      {venue === "cellana" && cellanaCurves.length > 0 && (
        <div className="swap-row">
          <label>Cellana curve</label>
          <select
            className="token-select full"
            value={selectedCellanaStable === null ? "" : selectedCellanaStable ? "stable" : "volatile"}
            onChange={(e) => setSelectedCellanaStable(e.target.value === "stable")}
          >
            {cellanaCurves.map((s) => (
              <option key={s ? "stable" : "volatile"} value={s ? "stable" : "volatile"}>
                {s ? "Stable curve" : "Volatile curve"}
              </option>
            ))}
          </select>
        </div>
      )}

      {poolLookupErr && <div className="hint">{poolLookupErr}</div>}

      <button
        type="button"
        className="primary"
        onClick={scan}
        disabled={scanDisabled}
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
              label={`Darbitex → ${venueLabel}`}
              row={preview.darbitexFirst}
              isBest={preview.best?.thalaFirst === false}
              borrowSymbol={borrowAsset.symbol}
              otherSymbol={otherAsset.symbol}
              borrowDecimals={borrowAsset.decimals}
              otherDecimals={otherAsset.decimals}
            />
            <DirectionRow
              label={`${venueLabel} → Darbitex`}
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
              <strong>
                {preview.best.thalaFirst
                  ? `${venueLabel} → Darbitex`
                  : `Darbitex → ${venueLabel}`}
              </strong>
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
              amount, pair, venue, or pool — or accept that current reserves
              don't offer a cycle above the LP + gas floor.
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
