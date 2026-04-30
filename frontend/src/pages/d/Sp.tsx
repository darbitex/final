import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useCallback, useEffect, useState } from "react";
import { D_PACKAGE, D_PARAMS, TOKENS } from "../../config";
import { useFaBalance } from "../../chain/balance";
import { dSpOf, dSpPoolBalance, dTotals, type Totals } from "../../chain/d";
import { decodeDError } from "../../chain/dErrors";
import { formatApt, formatD } from "../../chain/dFormat";
import { createRpcPool, toRaw } from "../../chain/rpc-pool";
import { useAddress } from "../../wallet/useConnect";

const rpc = createRpcPool("d-sp");

type SpState = {
  effectiveBalance: bigint;
  pendingD: bigint;
  pendingColl: bigint;
  totals: Totals;
  spPoolRaw: bigint;
};

export function DSp() {
  const { signAndSubmitTransaction } = useWallet();
  const address = useAddress();
  const d = TOKENS.D;
  const dBal = useFaBalance(d.meta, d.decimals);

  const [state, setState] = useState<SpState | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const [depositAmt, setDepositAmt] = useState("");
  const [withdrawAmt, setWithdrawAmt] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [totals, spPoolRaw] = await Promise.all([
          dTotals(rpc),
          dSpPoolBalance(rpc),
        ]);
        let sp = { effectiveBalance: 0n, pendingD: 0n, pendingColl: 0n };
        if (address) sp = await dSpOf(rpc, address);
        if (!cancelled) setState({ ...sp, totals, spPoolRaw });
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

  function resetMsgs() {
    setError(null);
    setLastTx(null);
  }

  async function submitDeposit() {
    if (!address) return;
    const n = Number(depositAmt);
    if (!Number.isFinite(n) || n <= 0) return;
    setSubmitting(true);
    setAction("deposit");
    resetMsgs();
    try {
      const amt = toRaw(n, D_PARAMS.D_DECIMALS);
      const result = await signAndSubmitTransaction({
        data: {
          function: `${D_PACKAGE}::D::sp_deposit`,
          typeArguments: [],
          functionArguments: [amt.toString()],
        },
      });
      setLastTx(result.hash);
      setDepositAmt("");
      dBal.refresh();
      refresh();
    } catch (e) {
      setError(decodeDError(e));
    } finally {
      setSubmitting(false);
      setAction(null);
    }
  }

  async function submitWithdraw() {
    if (!address) return;
    const n = Number(withdrawAmt);
    if (!Number.isFinite(n) || n <= 0) return;
    setSubmitting(true);
    setAction("withdraw");
    resetMsgs();
    try {
      const amt = toRaw(n, D_PARAMS.D_DECIMALS);
      const result = await signAndSubmitTransaction({
        data: {
          function: `${D_PACKAGE}::D::sp_withdraw`,
          typeArguments: [],
          functionArguments: [amt.toString()],
        },
      });
      setLastTx(result.hash);
      setWithdrawAmt("");
      dBal.refresh();
      refresh();
    } catch (e) {
      setError(decodeDError(e));
    } finally {
      setSubmitting(false);
      setAction(null);
    }
  }

  async function submitClaim() {
    if (!address) return;
    setSubmitting(true);
    setAction("claim");
    resetMsgs();
    try {
      const result = await signAndSubmitTransaction({
        data: {
          function: `${D_PACKAGE}::D::sp_claim`,
          typeArguments: [],
          functionArguments: [],
        },
      });
      setLastTx(result.hash);
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
    return <p className="page-sub">Connect your wallet to interact with the Stability Pool.</p>;
  }

  const donationDelta = state ? state.spPoolRaw - state.totals.totalSp : 0n;

  return (
    <>
      <p className="page-sub">
        Deposit D to earn liquidation bonuses (split 25% to liquidator / 25% to
        reserve / 50% to SP collateral pool) plus 90% of mint+redeem fees
        pro-rata to keyed depositors. For permanent agnostic donations (no
        keyed credit) use the Donate page.
      </p>

      {loading && !state && <div className="hint">Loading SP…</div>}

      {state && (
        <section className="protocol-grid">
          <div className="protocol-card small">
            <div className="protocol-label">Your SP balance</div>
            <div className="protocol-big">{formatD(state.effectiveBalance)}</div>
            <div className="protocol-note">D effective</div>
          </div>
          <div className="protocol-card small">
            <div className="protocol-label">Pending D reward</div>
            <div className="protocol-big">{formatD(state.pendingD, 6)}</div>
            <div className="protocol-note">fee / surplus share</div>
          </div>
          <div className="protocol-card small">
            <div className="protocol-label">Pending APT reward</div>
            <div className="protocol-big">{formatApt(state.pendingColl, 6)}</div>
            <div className="protocol-note">liquidation bonus share</div>
          </div>
          <div className="protocol-card small">
            <div className="protocol-label">Pool total</div>
            <div className="protocol-big">{formatD(state.spPoolRaw)}</div>
            <div className="protocol-note">
              keyed {formatD(state.totals.totalSp)} +{" "}
              {formatD(donationDelta > 0n ? donationDelta : 0n, 6)} donation
            </div>
          </div>
        </section>
      )}

      <h2 className="section-title">Deposit</h2>
      <div className="card" style={{ padding: 16 }}>
        <div className="swap-row">
          <label>D to deposit</label>
          <div className="swap-input">
            <input
              type="number"
              placeholder="0.0"
              min="0"
              value={depositAmt}
              onChange={(e) => setDepositAmt(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="bal-link"
            onClick={() => setDepositAmt(String(dBal.formatted))}
            disabled={dBal.raw === 0n}
          >
            Balance: {dBal.loading ? "…" : dBal.formatted.toFixed(4)} D
          </button>
        </div>
        {error && action === "deposit" && <div className="err">{error}</div>}
        <button
          type="button"
          className="primary"
          disabled={!depositAmt || Number(depositAmt) <= 0 || submitting}
          onClick={submitDeposit}
        >
          {submitting && action === "deposit" ? "Submitting…" : "Deposit D"}
        </button>
      </div>

      <h2 className="section-title">Withdraw</h2>
      <div className="card" style={{ padding: 16 }}>
        <div className="swap-row">
          <label>D to withdraw</label>
          <div className="swap-input">
            <input
              type="number"
              placeholder="0.0"
              min="0"
              value={withdrawAmt}
              onChange={(e) => setWithdrawAmt(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="bal-link"
            onClick={() =>
              setWithdrawAmt(
                state
                  ? String(Number(state.effectiveBalance) / 10 ** D_PARAMS.D_DECIMALS)
                  : "",
              )
            }
            disabled={!state || state.effectiveBalance === 0n}
          >
            In pool: {state ? formatD(state.effectiveBalance) : "—"} D
          </button>
        </div>
        {error && action === "withdraw" && <div className="err">{error}</div>}
        <button
          type="button"
          className="primary"
          disabled={!withdrawAmt || Number(withdrawAmt) <= 0 || submitting}
          onClick={submitWithdraw}
        >
          {submitting && action === "withdraw" ? "Submitting…" : "Withdraw D"}
        </button>
      </div>

      <h2 className="section-title">Claim rewards</h2>
      <p className="page-sub">
        Pull accumulated D + APT rewards without touching principal.
      </p>
      <div className="card" style={{ padding: 16 }}>
        {error && action === "claim" && <div className="err">{error}</div>}
        <button
          type="button"
          className="primary"
          disabled={
            submitting ||
            !state ||
            (state.pendingD === 0n && state.pendingColl === 0n)
          }
          onClick={submitClaim}
        >
          {submitting && action === "claim" ? "Submitting…" : "Claim pending"}
        </button>
      </div>

      {lastTx && !submitting && (
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
    </>
  );
}
