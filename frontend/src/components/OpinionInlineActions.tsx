// OpinionInlineActions — compact YAY/NAY trade UI embedded inside FeedRow
// when an opinion market exists for that mint. Lets a viewer opiniate
// directly from the timeline without navigating to the dedicated market page.
//
// Action surface (kept intentionally small):
//   - Show belief % and pool depth at a glance
//   - "Buy YAY" / "Buy NAY" → expand amount form → submit deposit_pick_side
//   - Full advanced ops (swap, redeem, balanced) live on /desnet/opinion/...
//
// Single-tx submission via deposit_pick_side. We use this entry intentionally
// for the timeline UX: one wallet popup, atomic, fast. Trade-off: half the
// minted opposite-side goes to pool depth (acts as LP deposit). For pure
// directional exposure with 2x the YAY per collateral, users go to the full
// market page → "Balanced" + "Swap" mode chain. Subtle hint surfaces this.

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useAddress } from "../wallet/useConnect";
import { fetchFaBalance } from "../chain/balance";
import { createRpcPool } from "../chain/rpc-pool";
import {
  creatorTokenOf,
  formatTokenAmount,
  loadBuyOneSidedScript,
  poolReserves,
  previewBuyOneSided,
  taxBpsOf,
  vaultBalance,
  wholeToRaw,
} from "../chain/desnet/opinion";

const rpc = createRpcPool("opinion-inline");

type Side = "YAY" | "NAY";

type MarketSnap = {
  poolYay: bigint;
  poolNay: bigint;
  vault: bigint;
  taxBps: number;
  creatorToken: string;
};

export function OpinionInlineActions({
  authorPid,
  seq,
  authorHandle,
}: {
  authorPid: string;
  seq: number;
  authorHandle: string;
}) {
  const myAddr = useAddress();
  const { signAndSubmitTransaction } = useWallet();

  const [snap, setSnap] = useState<MarketSnap | null>(null);
  const [creatorBalance, setCreatorBalance] = useState<bigint | null>(null);
  const [openForm, setOpenForm] = useState<Side | null>(null);
  const [amountInput, setAmountInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  // Snapshot loader — small Promise.all to keep network round-trips low
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      poolReserves(rpc, authorPid, seq),
      vaultBalance(rpc, authorPid, seq),
      taxBpsOf(rpc, authorPid, seq),
      creatorTokenOf(rpc, authorPid, seq),
    ])
      .then(([pr, v, t, ct]) => {
        if (cancelled) return;
        setSnap({ poolYay: pr.yay, poolNay: pr.nay, vault: v, taxBps: t, creatorToken: ct });
      })
      .catch(() => {
        // Swallow — opinion-mint detection passed but reserves view failed (rare,
        // could be RPC blip). Inline panel just renders nothing; full market
        // page will surface the error.
      });
    return () => { cancelled = true; };
  }, [authorPid, seq, refreshTick]);

  // Creator-token balance for the form (refresh after each tx via lastTx dep)
  useEffect(() => {
    let cancelled = false;
    if (!myAddr || !snap) {
      setCreatorBalance(null);
      return;
    }
    fetchFaBalance(myAddr, snap.creatorToken)
      .then((b) => { if (!cancelled) setCreatorBalance(b); })
      .catch(() => { if (!cancelled) setCreatorBalance(0n); });
    return () => { cancelled = true; };
  }, [myAddr, snap, lastTx]);

  // Belief % computed once per snap update — pool's NAY share = implied YAY belief
  // (rarer side is more expensive, mirrors opinion.move::yay_price_token_1e8 semantics)
  const belief = useMemo(() => {
    if (!snap) return null;
    const denom = snap.poolYay + snap.poolNay;
    if (denom === 0n) return { yay: 50, nay: 50 };
    const yay = Number((snap.poolNay * 10000n) / denom) / 100;
    return { yay, nay: 100 - yay };
  }, [snap]);

  // Validate amount input → raw, plus check chain bounds (1M..100M whole)
  const amountRaw: bigint | null = useMemo(() => {
    if (!amountInput.trim()) return null;
    try {
      return wholeToRaw(amountInput);
    } catch {
      return null;
    }
  }, [amountInput]);

  // Atomic balanced+swap preview — recomputes when amount or snap shifts.
  const previewYay = useMemo(() => {
    if (!snap || amountRaw === null || amountRaw <= 0n) return null;
    return previewBuyOneSided(snap.poolYay, snap.poolNay, amountRaw, true, snap.taxBps);
  }, [snap, amountRaw]);
  const previewNay = useMemo(() => {
    if (!snap || amountRaw === null || amountRaw <= 0n) return null;
    return previewBuyOneSided(snap.poolYay, snap.poolNay, amountRaw, false, snap.taxBps);
  }, [snap, amountRaw]);

  const activePreview = openForm === "YAY" ? previewYay : openForm === "NAY" ? previewNay : null;

  const valid = (() => {
    if (amountRaw === null || amountRaw <= 0n)
      return { ok: false, reason: "Enter a positive amount." };
    if (!activePreview) return { ok: false, reason: "Loading preview…" };
    if (activePreview.zeroOutputRisk)
      return { ok: false, reason: "Pool reserves too thin on the wanted side — swap leg would return 0. Try smaller amount." };
    if (creatorBalance === null) return { ok: true, reason: "" };
    if (creatorBalance < activePreview.totalCreatorTokenNeeded) {
      return {
        ok: false,
        reason: `Need ${formatTokenAmount(activePreview.totalCreatorTokenNeeded)} $${authorHandle} (= ${formatTokenAmount(amountRaw)} vault + ${formatTokenAmount(activePreview.depositTax)} deposit tax + ${formatTokenAmount(activePreview.swapTax)} swap tax). Wallet: ${formatTokenAmount(creatorBalance)}.`,
      };
    }
    return { ok: true, reason: "" };
  })();

  async function submit(side: Side) {
    if (amountRaw === null || !snap) return;
    const preview = side === "YAY" ? previewYay : previewNay;
    if (!preview) return;
    setError(null);
    setLastTx(null);
    setSubmitting(true);
    try {
      // Atomic balanced+swap via bundled Move script. min_swap_out enforces
      // 2% slippage tolerance; aborts E_SLIPPAGE_EXCEEDED if pool moves.
      const bytecode = await loadBuyOneSidedScript();
      // Cast `data as never` — wallet adapter's bundled ts-sdk has different
      // ScriptArg types than the main ts-sdk; runtime accepts plain primitives.
      const result = await signAndSubmitTransaction({
        data: {
          bytecode,
          typeArguments: [],
          functionArguments: [
            authorPid,                      // address
            seq.toString(),                 // u64
            amountRaw.toString(),           // u64
            preview.minSwapOut.toString(),  // u64
            side === "YAY",                 // bool
          ],
        } as never,
      });
      setLastTx(result.hash);
      setOpenForm(null);
      setAmountInput("");
      setRefreshTick((t) => t + 1);
    } catch (e) {
      setError(decodeOpinionError(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (!snap || !belief) return null;

  return (
    <div
      className="opinion-inline"
      style={{
        marginTop: 8,
        padding: 8,
        background: "#0a1a2a",
        borderLeft: "3px solid #1a4480",
        borderRadius: 4,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong className="ok">{belief.yay.toFixed(1)}% YAY</strong>
        <span className="muted">·</span>
        <strong className="error">{belief.nay.toFixed(1)}% NAY</strong>
        <span className="muted small">
          (pool {formatTokenAmount(snap.poolYay)}/{formatTokenAmount(snap.poolNay)} ·
          vault {formatTokenAmount(snap.vault)})
        </span>
        <span style={{ flex: 1 }} />
        {/* Show Buy YAY/NAY to ALL viewers (guests too) — disabled when wallet
            not connected, with tooltip. Same principle as the spark/echo/press
            row: guests SEE the affordance, only INTERACTION is gated. */}
        {!openForm && (
          <>
            <button
              className="link"
              onClick={() => { setOpenForm("YAY"); setError(null); }}
              disabled={!myAddr || submitting}
              style={{ color: "#0EF" }}
              title={!myAddr ? "Connect a wallet to opiniate" : undefined}
            >
              + Buy YAY
            </button>
            <button
              className="link"
              onClick={() => { setOpenForm("NAY"); setError(null); }}
              disabled={!myAddr || submitting}
              style={{ color: "#f97316" }}
              title={!myAddr ? "Connect a wallet to opiniate" : undefined}
            >
              + Buy NAY
            </button>
          </>
        )}
        <Link
          to={`/desnet/social/opinion/${authorPid}/${seq}`}
          className="muted small"
          style={{ marginLeft: 4 }}
        >
          full market →
        </Link>
      </div>

      {openForm && (
        <div style={{ marginTop: 8, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span className="small">
            Buy <strong className={openForm === "YAY" ? "ok" : "error"}>{openForm}</strong> with $
            <code>{authorHandle}</code>:
          </span>
          <input
            type="number"
            min="0"
            step="any"
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
            placeholder="amount (whole)"
            style={{ width: 140 }}
            autoFocus
          />
          <button
            className="primary"
            onClick={() => submit(openForm)}
            disabled={!valid.ok || submitting}
          >
            {submitting ? "Submitting…" : `Buy ${openForm}`}
          </button>
          <button
            className="link"
            onClick={() => { setOpenForm(null); setAmountInput(""); setError(null); }}
            disabled={submitting}
          >
            cancel
          </button>
          {amountRaw !== null && activePreview && (
            <small className={valid.ok ? "muted" : "error"} style={{ width: "100%" }}>
              {valid.ok && (
                <>
                  ✓ <strong>1-tx atomic</strong> · You receive{" "}
                  <strong>{formatTokenAmount(activePreview.wantedSideOut)} {openForm}</strong>{" "}
                  ({activePreview.multiplier.toFixed(2)}× vs raw deposit) ·{" "}
                  Total cost{" "}
                  <strong>{formatTokenAmount(activePreview.totalCreatorTokenNeeded)}</strong>{" "}
                  ${authorHandle} ({formatTokenAmount(amountRaw)} vault +{" "}
                  {formatTokenAmount(activePreview.depositTax)} dep tax +{" "}
                  {formatTokenAmount(activePreview.swapTax)} swap tax) ·{" "}
                  min_swap_out{" "}
                  <strong>{formatTokenAmount(activePreview.minSwapOut)}</strong>{" "}
                  (2% slip floor) ·{" "}
                  <Link to={`/desnet/social/opinion/${authorPid}/${seq}`}>advanced →</Link>
                </>
              )}
              {!valid.ok && valid.reason}
            </small>
          )}
        </div>
      )}

      {lastTx && (
        <p className="ok small" style={{ marginTop: 6 }}>
          Done.{" "}
          <a
            href={`https://explorer.aptoslabs.com/txn/${lastTx}?network=mainnet`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {lastTx.slice(0, 10)}…
          </a>
        </p>
      )}
      {error && <p className="error small" style={{ marginTop: 6 }}>{error}</p>}
    </div>
  );
}

function decodeOpinionError(err: unknown): string {
  const msg = (err as { message?: string })?.message ?? String(err);
  if (/User rejected|denied|cancel/i.test(msg)) return "Cancelled in wallet.";
  if (/EINSUFFICIENT_BALANCE|coin store empty/i.test(msg))
    return `Insufficient $creator balance for amount + tax burns.`;
  // E_SLIPPAGE_EXCEEDED=7 — common during MEV/race
  if (/abort.*7\b|E_SLIPPAGE_EXCEEDED/i.test(msg))
    return "Pool moved between preview and submit. Try again — the script's 2% slippage floor is tight.";
  // E_ZERO_OUTPUT=14 — extreme pool skew
  if (/abort.*14\b|E_ZERO_OUTPUT/i.test(msg))
    return "Swap leg returned zero output (pool too skewed). Try smaller amount.";
  const m = msg.match(/Move abort.*opinion::([A-Z_0-9]+)/);
  if (m) return `opinion::${m[1]}`;
  return msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
}
