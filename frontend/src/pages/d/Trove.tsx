import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { D_PACKAGE, D_PARAMS, TOKENS } from "../../config";
import { useFaBalance } from "../../chain/balance";
import {
  dCloseCost,
  dPrice8dec,
  dTroveHealth,
} from "../../chain/d";
import { decodeDError } from "../../chain/dErrors";
import { formatApt, formatAptUsd, formatCrBps, formatD } from "../../chain/dFormat";
import { fetchAptUsdVaa } from "../../chain/pyth";
import { createRpcPool, fromRaw, toRaw } from "../../chain/rpc-pool";
import { useAddress } from "../../wallet/useConnect";

const rpc = createRpcPool("d-trove");

type TroveState = {
  collateral: bigint;
  debt: bigint;
  crBps: bigint;
  priceRaw: bigint;
  closeCost: bigint;
};

export function DTrove() {
  const { signAndSubmitTransaction } = useWallet();
  const address = useAddress();
  const apt = TOKENS.APT;
  const d = TOKENS.D;
  const aptBal = useFaBalance(apt.meta, apt.decimals);
  const dBal = useFaBalance(d.meta, d.decimals);

  const [state, setState] = useState<TroveState | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const [collAmt, setCollAmt] = useState("");
  const [debtAmt, setDebtAmt] = useState("");
  const [addCollAmt, setAddCollAmt] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  useEffect(() => {
    if (!address) {
      setState(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [health, priceRaw] = await Promise.all([
          dTroveHealth(rpc, address),
          dPrice8dec(rpc),
        ]);
        let closeCost = 0n;
        if (health.debt > 0n) {
          closeCost = await dCloseCost(rpc, address);
        }
        if (!cancelled) {
          setState({ ...health, priceRaw, closeCost });
        }
      } catch (e) {
        if (!cancelled) setError(decodeDError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, refreshKey]);

  const hasTrove = (state?.debt ?? 0n) > 0n;

  const projected = useMemo(() => {
    if (!state) return null;
    const collNum = Number(collAmt);
    const debtNum = Number(debtAmt);
    if (!Number.isFinite(collNum) || collNum <= 0) return null;
    if (!Number.isFinite(debtNum) || debtNum <= 0) return null;
    const collRaw = toRaw(collNum, D_PARAMS.APT_DECIMALS);
    const debtRaw = toRaw(debtNum, D_PARAMS.D_DECIMALS);
    const newColl = state.collateral + collRaw;
    const newDebt = state.debt + debtRaw;
    if (newDebt === 0n) return null;
    const collUsdRaw = (newColl * state.priceRaw) / 100_000_000n;
    const crBps = (collUsdRaw * 10_000n) / newDebt;
    const feeRaw = (debtRaw * BigInt(D_PARAMS.FEE_BPS)) / 10_000n;
    const netMint = debtRaw - feeRaw;
    return { newColl, newDebt, crBps, netMint, feeRaw };
  }, [collAmt, debtAmt, state]);

  function resetMsgs() {
    setError(null);
    setLastTx(null);
  }

  async function submitOpen() {
    if (!address || !projected) return;
    setSubmitting(true);
    setAction("open");
    resetMsgs();
    try {
      const vaa = await fetchAptUsdVaa();
      const collRaw = toRaw(Number(collAmt), D_PARAMS.APT_DECIMALS);
      const debtRaw = toRaw(Number(debtAmt), D_PARAMS.D_DECIMALS);
      const result = await signAndSubmitTransaction({
        data: {
          function: `${D_PACKAGE}::D::open_trove_pyth`,
          typeArguments: [],
          functionArguments: [collRaw.toString(), debtRaw.toString(), vaa],
        },
      });
      setLastTx(result.hash);
      setCollAmt("");
      setDebtAmt("");
      aptBal.refresh();
      dBal.refresh();
      refresh();
    } catch (e) {
      setError(decodeDError(e));
    } finally {
      setSubmitting(false);
      setAction(null);
    }
  }

  async function submitAddColl() {
    if (!address) return;
    const n = Number(addCollAmt);
    if (!Number.isFinite(n) || n <= 0) return;
    setSubmitting(true);
    setAction("add");
    resetMsgs();
    try {
      const collRaw = toRaw(n, D_PARAMS.APT_DECIMALS);
      const result = await signAndSubmitTransaction({
        data: {
          function: `${D_PACKAGE}::D::add_collateral`,
          typeArguments: [],
          functionArguments: [collRaw.toString()],
        },
      });
      setLastTx(result.hash);
      setAddCollAmt("");
      aptBal.refresh();
      refresh();
    } catch (e) {
      setError(decodeDError(e));
    } finally {
      setSubmitting(false);
      setAction(null);
    }
  }

  async function submitClose() {
    if (!address) return;
    setSubmitting(true);
    setAction("close");
    resetMsgs();
    try {
      const result = await signAndSubmitTransaction({
        data: {
          function: `${D_PACKAGE}::D::close_trove`,
          typeArguments: [],
          functionArguments: [],
        },
      });
      setLastTx(result.hash);
      aptBal.refresh();
      dBal.refresh();
      refresh();
    } catch (e) {
      setError(decodeDError(e));
    } finally {
      setSubmitting(false);
      setAction(null);
    }
  }

  if (!address) {
    return <p className="page-sub">Connect your wallet to open or manage a trove.</p>;
  }

  return (
    <>
      {loading && !state && <div className="hint">Loading trove…</div>}

      {state && (
        <section className="protocol-grid">
          <div className="protocol-card small">
            <div className="protocol-label">Collateral</div>
            <div className="protocol-big">{formatApt(state.collateral)}</div>
            <div className="protocol-note">APT</div>
          </div>
          <div className="protocol-card small">
            <div className="protocol-label">Debt</div>
            <div className="protocol-big">{formatD(state.debt)}</div>
            <div className="protocol-note">D</div>
          </div>
          <div className="protocol-card small">
            <div className="protocol-label">Collateral ratio</div>
            <div
              className="protocol-big"
              style={{
                color:
                  state.debt === 0n
                    ? "#888"
                    : state.crBps < BigInt(D_PARAMS.LIQ_THRESHOLD_BPS)
                      ? "#ff6b6b"
                      : state.crBps < BigInt(D_PARAMS.MCR_BPS)
                        ? "#ff8800"
                        : "#6eff8e",
              }}
            >
              {formatCrBps(state.crBps)}
            </div>
            <div className="protocol-note">
              MCR {D_PARAMS.MCR_BPS / 100}% · LIQ {D_PARAMS.LIQ_THRESHOLD_BPS / 100}%
            </div>
          </div>
          <div className="protocol-card small">
            <div className="protocol-label">APT / USD (Pyth)</div>
            <div className="protocol-big">{formatAptUsd(state.priceRaw)}</div>
            <div className="protocol-note">Refresh on open/redeem/liquidate</div>
          </div>
        </section>
      )}

      <h2 className="section-title">{hasTrove ? "Augment trove" : "Open trove"}</h2>
      <p className="page-sub">
        {hasTrove
          ? "Adding collateral + debt in one call (routes through open_trove_pyth; impl merges into your existing position)."
          : "Deposit APT as collateral, mint D as debt. MCR 200%. 1% flat mint fee, 10/90 split: 10% to SP pool, 90% to keyed SP depositors."}
      </p>

      <div className="card" style={{ padding: 16 }}>
        <div className="swap-row">
          <label>Collateral (APT)</label>
          <div className="swap-input">
            <input
              type="number"
              placeholder="0.0"
              min="0"
              value={collAmt}
              onChange={(e) => setCollAmt(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="bal-link"
            onClick={() => setCollAmt(String(aptBal.formatted))}
            disabled={aptBal.raw === 0n}
          >
            Balance: {aptBal.loading ? "…" : aptBal.formatted.toFixed(6)} APT
          </button>
        </div>
        <div className="swap-row">
          <label>Debt to mint (D)</label>
          <div className="swap-input">
            <input
              type="number"
              placeholder={`≥ ${fromRaw(D_PARAMS.MIN_DEBT_RAW, D_PARAMS.D_DECIMALS)}`}
              min="0"
              value={debtAmt}
              onChange={(e) => setDebtAmt(e.target.value)}
            />
          </div>
        </div>

        {projected && (
          <div className="hint">
            Projected: {formatApt(projected.newColl)} APT collateral /{" "}
            {formatD(projected.newDebt)} D debt · CR {formatCrBps(projected.crBps)}
            {" · "}Net mint {formatD(projected.netMint)} D (fee{" "}
            {formatD(projected.feeRaw, 6)})
          </div>
        )}

        {error && action === "open" && <div className="err">{error}</div>}
        {lastTx && action === null && (
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

        <button
          type="button"
          className="primary"
          disabled={!projected || submitting}
          onClick={submitOpen}
        >
          {submitting && action === "open"
            ? "Submitting…"
            : hasTrove
              ? "Augment trove"
              : "Open trove"}
        </button>
      </div>

      {hasTrove && (
        <>
          <h2 className="section-title">Add collateral only</h2>
          <p className="page-sub">
            Top up CR without minting more D. No oracle refresh needed.
          </p>
          <div className="card" style={{ padding: 16 }}>
            <div className="swap-row">
              <label>APT to add</label>
              <div className="swap-input">
                <input
                  type="number"
                  placeholder="0.0"
                  min="0"
                  value={addCollAmt}
                  onChange={(e) => setAddCollAmt(e.target.value)}
                />
              </div>
              <button
                type="button"
                className="bal-link"
                onClick={() => setAddCollAmt(String(aptBal.formatted))}
                disabled={aptBal.raw === 0n}
              >
                Balance: {aptBal.loading ? "…" : aptBal.formatted.toFixed(6)}
              </button>
            </div>
            {error && action === "add" && <div className="err">{error}</div>}
            <button
              type="button"
              className="primary"
              disabled={!addCollAmt || Number(addCollAmt) <= 0 || submitting}
              onClick={submitAddColl}
            >
              {submitting && action === "add" ? "Submitting…" : "Add collateral"}
            </button>
          </div>

          <h2 className="section-title">Close trove</h2>
          <p className="page-sub">
            Burn your full debt (D in wallet) and withdraw all collateral. Note:
            the 1% fee was charged at mint time, so you received{" "}
            <code>debt − 1%</code> but need <code>debt</code> to close — source the
            gap from secondary market or SP withdraw.
          </p>
          <div className="card" style={{ padding: 16 }}>
            <div className="hint">
              D to burn: {formatD(state?.closeCost ?? 0n)} · Your D balance:{" "}
              {dBal.loading ? "…" : dBal.formatted.toFixed(4)}
            </div>
            {error && action === "close" && <div className="err">{error}</div>}
            <button
              type="button"
              className="primary"
              disabled={
                submitting ||
                !state ||
                state.closeCost === 0n ||
                dBal.raw < state.closeCost
              }
              onClick={submitClose}
            >
              {submitting && action === "close" ? "Submitting…" : "Close trove"}
            </button>
            {state && dBal.raw < state.closeCost && (
              <div className="err">
                Need {formatD(state.closeCost - dBal.raw)} more D in wallet to close.
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
