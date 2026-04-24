import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useCallback, useEffect, useState } from "react";
import { ONE_PACKAGE, ONE_PARAMS, TOKENS } from "../../config";
import { useFaBalance } from "../../chain/balance";
import { oneSpOf, oneTotals, type Totals } from "../../chain/one";
import { decodeOneError } from "../../chain/oneErrors";
import { formatApt, formatOne } from "../../chain/oneFormat";
import { createRpcPool, toRaw } from "../../chain/rpc-pool";
import { useAddress } from "../../wallet/useConnect";

const rpc = createRpcPool("one-sp");

type SpState = {
  effectiveBalance: bigint;
  pendingOne: bigint;
  pendingColl: bigint;
  totals: Totals;
};

export function OneSp() {
  const { signAndSubmitTransaction } = useWallet();
  const address = useAddress();
  const one = TOKENS.ONE;
  const oneBal = useFaBalance(one.meta, one.decimals);

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
        const totals = await oneTotals(rpc);
        let sp = { effectiveBalance: 0n, pendingOne: 0n, pendingColl: 0n };
        if (address) sp = await oneSpOf(rpc, address);
        if (!cancelled) setState({ ...sp, totals });
      } catch (e) {
        if (!cancelled) setError(decodeOneError(e));
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
      const amt = toRaw(n, ONE_PARAMS.ONE_DECIMALS);
      const result = await signAndSubmitTransaction({
        data: {
          function: `${ONE_PACKAGE}::ONE::sp_deposit`,
          typeArguments: [],
          functionArguments: [amt.toString()],
        },
      });
      setLastTx(result.hash);
      setDepositAmt("");
      oneBal.refresh();
      refresh();
    } catch (e) {
      setError(decodeOneError(e));
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
      const amt = toRaw(n, ONE_PARAMS.ONE_DECIMALS);
      const result = await signAndSubmitTransaction({
        data: {
          function: `${ONE_PACKAGE}::ONE::sp_withdraw`,
          typeArguments: [],
          functionArguments: [amt.toString()],
        },
      });
      setLastTx(result.hash);
      setWithdrawAmt("");
      oneBal.refresh();
      refresh();
    } catch (e) {
      setError(decodeOneError(e));
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
          function: `${ONE_PACKAGE}::ONE::sp_claim`,
          typeArguments: [],
          functionArguments: [],
        },
      });
      setLastTx(result.hash);
      oneBal.refresh();
      refresh();
    } catch (e) {
      setError(decodeOneError(e));
    } finally {
      setSubmitting(false);
      setAction(null);
    }
  }

  if (!address) {
    return <p className="page-sub">Connect your wallet to interact with the Stability Pool.</p>;
  }

  return (
    <>
      <p className="page-sub">
        Deposit ONE to earn liquidation bonuses (10% APT surplus). No oracle
        refresh required. Your share may dilute if the pool absorbs large debts
        (product-factor decay).
      </p>

      {loading && !state && <div className="hint">Loading SP…</div>}

      {state && (
        <section className="protocol-grid">
          <div className="protocol-card small">
            <div className="protocol-label">Your SP balance</div>
            <div className="protocol-big">{formatOne(state.effectiveBalance)}</div>
            <div className="protocol-note">ONE effective</div>
          </div>
          <div className="protocol-card small">
            <div className="protocol-label">Pending ONE reward</div>
            <div className="protocol-big">{formatOne(state.pendingOne, 6)}</div>
            <div className="protocol-note">fee / surplus share</div>
          </div>
          <div className="protocol-card small">
            <div className="protocol-label">Pending APT reward</div>
            <div className="protocol-big">{formatApt(state.pendingColl, 6)}</div>
            <div className="protocol-note">liquidation bonus share</div>
          </div>
          <div className="protocol-card small">
            <div className="protocol-label">Pool total</div>
            <div className="protocol-big">{formatOne(state.totals.totalSp)}</div>
            <div className="protocol-note">ONE deposited</div>
          </div>
        </section>
      )}

      <h2 className="section-title">Deposit</h2>
      <div className="card" style={{ padding: 16 }}>
        <div className="swap-row">
          <label>ONE to deposit</label>
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
            onClick={() => setDepositAmt(String(oneBal.formatted))}
            disabled={oneBal.raw === 0n}
          >
            Balance: {oneBal.loading ? "…" : oneBal.formatted.toFixed(4)} ONE
          </button>
        </div>
        {error && action === "deposit" && <div className="err">{error}</div>}
        <button
          type="button"
          className="primary"
          disabled={!depositAmt || Number(depositAmt) <= 0 || submitting}
          onClick={submitDeposit}
        >
          {submitting && action === "deposit" ? "Submitting…" : "Deposit ONE"}
        </button>
      </div>

      <h2 className="section-title">Withdraw</h2>
      <div className="card" style={{ padding: 16 }}>
        <div className="swap-row">
          <label>ONE to withdraw</label>
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
                  ? String(Number(state.effectiveBalance) / 10 ** ONE_PARAMS.ONE_DECIMALS)
                  : "",
              )
            }
            disabled={!state || state.effectiveBalance === 0n}
          >
            In pool: {state ? formatOne(state.effectiveBalance) : "—"} ONE
          </button>
        </div>
        {error && action === "withdraw" && <div className="err">{error}</div>}
        <button
          type="button"
          className="primary"
          disabled={!withdrawAmt || Number(withdrawAmt) <= 0 || submitting}
          onClick={submitWithdraw}
        >
          {submitting && action === "withdraw" ? "Submitting…" : "Withdraw ONE"}
        </button>
      </div>

      <h2 className="section-title">Claim rewards</h2>
      <p className="page-sub">
        Pull accumulated ONE + APT rewards without touching principal.
      </p>
      <div className="card" style={{ padding: 16 }}>
        {error && action === "claim" && <div className="err">{error}</div>}
        <button
          type="button"
          className="primary"
          disabled={
            submitting ||
            !state ||
            (state.pendingOne === 0n && state.pendingColl === 0n)
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
