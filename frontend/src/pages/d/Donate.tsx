import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useCallback, useEffect, useState } from "react";
import { D_PACKAGE, D_PARAMS, TOKENS } from "../../config";
import { useFaBalance } from "../../chain/balance";
import { readDonationStats, type DonationStats } from "../../chain/d";
import { decodeDError } from "../../chain/dErrors";
import { formatApt, formatD } from "../../chain/dFormat";
import { createRpcPool, toRaw } from "../../chain/rpc-pool";
import { useAddress } from "../../wallet/useConnect";

const rpc = createRpcPool("d-donate");

function shortAddr(a: string): string {
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function DDonate() {
  const { signAndSubmitTransaction } = useWallet();
  const address = useAddress();
  const apt = TOKENS.APT;
  const d = TOKENS.D;
  const aptBal = useFaBalance(apt.meta, apt.decimals);
  const dBal = useFaBalance(d.meta, d.decimals);

  const [spStr, setSpStr] = useState("");
  const [rsvStr, setRsvStr] = useState("");

  const [stats, setStats] = useState<DonationStats | null>(null);
  const [loadingStats, setLoadingStats] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const [submitting, setSubmitting] = useState(false);
  const [action, setAction] = useState<"sp" | "reserve" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingStats(true);
    readDonationStats(rpc)
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch((e) => {
        if (!cancelled) setError(decodeDError(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingStats(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  function resetMsgs() {
    setError(null);
    setLastTx(null);
  }

  async function submitSpDonate() {
    if (!address) return;
    const n = Number(spStr);
    if (!Number.isFinite(n) || n <= 0) return;
    setSubmitting(true);
    setAction("sp");
    resetMsgs();
    try {
      const amt = toRaw(n, D_PARAMS.D_DECIMALS);
      const result = await signAndSubmitTransaction({
        data: {
          function: `${D_PACKAGE}::D::donate_to_sp`,
          typeArguments: [],
          functionArguments: [amt.toString()],
        },
      });
      setLastTx(result.hash);
      setSpStr("");
      dBal.refresh();
      refresh();
    } catch (e) {
      setError(decodeDError(e));
    } finally {
      setSubmitting(false);
      setAction(null);
    }
  }

  async function submitReserveDonate() {
    if (!address) return;
    const n = Number(rsvStr);
    if (!Number.isFinite(n) || n <= 0) return;
    setSubmitting(true);
    setAction("reserve");
    resetMsgs();
    try {
      const amt = toRaw(n, D_PARAMS.APT_DECIMALS);
      const result = await signAndSubmitTransaction({
        data: {
          function: `${D_PACKAGE}::D::donate_to_reserve`,
          typeArguments: [],
          functionArguments: [amt.toString()],
        },
      });
      setLastTx(result.hash);
      setRsvStr("");
      aptBal.refresh();
      refresh();
    } catch (e) {
      setError(decodeDError(e));
    } finally {
      setSubmitting(false);
      setAction(null);
    }
  }

  return (
    <>
      <div
        className="err"
        style={{ marginBottom: 12, lineHeight: 1.55 }}
      >
        <strong>Donations are permanent and irrevocable.</strong> No admin
        extraction path exists — you cannot withdraw what you donate. Treat
        both forms as one-way commitments to the D protocol.
        <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          <li>
            <strong>D → SP:</strong> economically equivalent to a{" "}
            <strong>burn</strong>. Donated D joins <code>sp_pool</code> and is
            consumed pro-rata in every future liquidation; the underlying D
            supply gets burned as part of the absorbed-debt math, gradually
            retiring your contribution from circulating supply over time.
          </li>
          <li>
            <strong>APT → Reserve:</strong> permanently leaves your wallet but
            is <em>not</em> burned — the APT sits in <code>reserve_coll</code>{" "}
            and flows out to anyone who burns D against the reserve via{" "}
            <code>redeem_from_reserve</code>. Effectively a one-way subsidy to
            D peg-defenders.
          </li>
        </ul>
      </div>

      <section className="protocol-grid">
        <div className="protocol-card small">
          <div className="protocol-label">D donated to SP (lifetime)</div>
          <div className="protocol-big">
            {stats ? formatD(stats.spTotalRaw) : "—"}
          </div>
          <div className="protocol-note">
            {stats
              ? `${stats.spCount} donation${stats.spCount === 1 ? "" : "s"} (incl. fee-driven)`
              : ""}
          </div>
        </div>
        <div className="protocol-card small">
          <div className="protocol-label">APT donated to reserve (lifetime)</div>
          <div className="protocol-big">
            {stats ? formatApt(stats.reserveTotalRaw) : "—"}
          </div>
          <div className="protocol-note">
            {stats
              ? `${stats.reserveCount} donation${stats.reserveCount === 1 ? "" : "s"}`
              : ""}
          </div>
        </div>
      </section>

      <h2 className="section-title">Donate D → SP</h2>
      <p className="page-sub">
        Agnostic Stability Pool donation. Joins <code>sp_pool</code> balance
        but does NOT increment <code>total_sp</code>, so keyed depositors are
        NOT diluted. Donated D burns gradually via future liquidation
        absorption — a permanent supply reduction. Oracle-free.
      </p>
      <div className="card" style={{ padding: 16 }}>
        {!address ? (
          <div className="hint">Connect your wallet to donate.</div>
        ) : (
          <>
            <div className="swap-row">
              <label>D to donate</label>
              <div className="swap-input">
                <input
                  type="number"
                  placeholder="0.0"
                  min="0"
                  value={spStr}
                  onChange={(e) => setSpStr(e.target.value)}
                />
              </div>
              <button
                type="button"
                className="bal-link"
                onClick={() => setSpStr(String(dBal.formatted))}
                disabled={dBal.raw === 0n}
              >
                Balance: {dBal.loading ? "…" : dBal.formatted.toFixed(4)} D
              </button>
            </div>
            {error && action === "sp" && <div className="err">{error}</div>}
            <button
              type="button"
              className="primary"
              disabled={!spStr || Number(spStr) <= 0 || submitting}
              onClick={submitSpDonate}
            >
              {submitting && action === "sp" ? "Submitting…" : "Donate D to SP"}
            </button>
          </>
        )}
      </div>

      <h2 className="section-title">Donate APT → Reserve</h2>
      <p className="page-sub">
        Fortifies <code>redeem_from_reserve</code> capacity. The protocol
        reserve grows from the 2.5% liquidation share + permissionless
        donations, and pays APT to anyone burning D against the reserve at
        Pyth spot. Oracle-free deposit; reserve-redeems still need a fresh
        oracle.
      </p>
      <div className="card" style={{ padding: 16 }}>
        {!address ? (
          <div className="hint">Connect your wallet to donate.</div>
        ) : (
          <>
            <div className="swap-row">
              <label>APT to donate</label>
              <div className="swap-input">
                <input
                  type="number"
                  placeholder="0.0"
                  min="0"
                  value={rsvStr}
                  onChange={(e) => setRsvStr(e.target.value)}
                />
              </div>
              <button
                type="button"
                className="bal-link"
                onClick={() => setRsvStr(String(aptBal.formatted))}
                disabled={aptBal.raw === 0n}
              >
                Balance: {aptBal.loading ? "…" : aptBal.formatted.toFixed(6)} APT
              </button>
            </div>
            {error && action === "reserve" && <div className="err">{error}</div>}
            <button
              type="button"
              className="primary"
              disabled={!rsvStr || Number(rsvStr) <= 0 || submitting}
              onClick={submitReserveDonate}
            >
              {submitting && action === "reserve"
                ? "Submitting…"
                : "Donate APT to reserve"}
            </button>
          </>
        )}
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

      <h2 className="section-title">Recent SP donations</h2>
      <div className="card" style={{ padding: 16 }}>
        {loadingStats && <div className="hint">Loading…</div>}
        {!loadingStats && (!stats || stats.recentSp.length === 0) && (
          <div className="hint">No SP donations yet.</div>
        )}
        {stats && stats.recentSp.length > 0 && (
          <div
            style={{
              maxHeight: 240,
              overflowY: "auto",
              border: "1px solid #1a1a1a",
              borderRadius: 6,
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "2fr 1fr 1fr",
                gap: 6,
                padding: "6px 10px",
                fontSize: 11,
                color: "#666",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                borderBottom: "1px solid #1a1a1a",
              }}
            >
              <span>Donor</span>
              <span>Amount (D)</span>
              <span>Tx</span>
            </div>
            {stats.recentSp.map((d) => (
              <div
                key={`${d.txVersion}-${d.donor}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "2fr 1fr 1fr",
                  gap: 6,
                  padding: "8px 10px",
                  fontSize: 12,
                  borderBottom: "1px solid #111",
                }}
              >
                <a
                  href={`https://explorer.aptoslabs.com/account/${d.donor}?network=mainnet`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontFamily: "monospace" }}
                >
                  {shortAddr(d.donor)}
                </a>
                <span>{formatD(d.amount, 6)}</span>
                <a
                  href={`https://explorer.aptoslabs.com/txn/${d.txVersion}?network=mainnet`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontFamily: "monospace" }}
                >
                  v{d.txVersion}
                </a>
              </div>
            ))}
          </div>
        )}
      </div>

      <h2 className="section-title">Recent reserve donations</h2>
      <div className="card" style={{ padding: 16 }}>
        {loadingStats && <div className="hint">Loading…</div>}
        {!loadingStats && (!stats || stats.recentReserve.length === 0) && (
          <div className="hint">No reserve donations yet.</div>
        )}
        {stats && stats.recentReserve.length > 0 && (
          <div
            style={{
              maxHeight: 240,
              overflowY: "auto",
              border: "1px solid #1a1a1a",
              borderRadius: 6,
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "2fr 1fr 1fr",
                gap: 6,
                padding: "6px 10px",
                fontSize: 11,
                color: "#666",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                borderBottom: "1px solid #1a1a1a",
              }}
            >
              <span>Donor</span>
              <span>Amount (APT)</span>
              <span>Tx</span>
            </div>
            {stats.recentReserve.map((d) => (
              <div
                key={`${d.txVersion}-${d.donor}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "2fr 1fr 1fr",
                  gap: 6,
                  padding: "8px 10px",
                  fontSize: 12,
                  borderBottom: "1px solid #111",
                }}
              >
                <a
                  href={`https://explorer.aptoslabs.com/account/${d.donor}?network=mainnet`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontFamily: "monospace" }}
                >
                  {shortAddr(d.donor)}
                </a>
                <span>{formatApt(d.amount, 6)}</span>
                <a
                  href={`https://explorer.aptoslabs.com/txn/${d.txVersion}?network=mainnet`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontFamily: "monospace" }}
                >
                  v{d.txVersion}
                </a>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
