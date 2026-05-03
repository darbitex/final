// OpinionList — discoverable list of opinion markets across curated PIDs.
// Plus a quick-jump dropdown (handle + seq) so users can paste/select any
// (PID, seq) pair to land on the dedicated swap UI.
//
// MVP scope: enumerates curated handles, fetches recent mints per handle,
// filters via market_exists. True "all on-chain opinion markets" needs an
// indexer satellite — same data-availability constraint as Feeds.

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createRpcPool } from "../../chain/rpc-pool";
import { deriveProfileAddress, handleToWallet } from "../../chain/desnet/profile";
import {
  formatTokenAmount,
  marketExists,
  poolReserves,
} from "../../chain/desnet/opinion";
import {
  VERB,
  decodeMintPayload,
  loadRecentHistory,
  type DecodedMint,
} from "../../chain/desnet/history";

const rpc = createRpcPool("desnet-opinion-list");

const CURATED_HANDLES = ["desnet", "darbitex", "aptos", "apt", "d"];
const PER_PROFILE_LIMIT = 30;

type OpinionEntry = {
  authorHandle: string;
  authorPid: string;
  seq: number;
  contentText: string;
  beliefYay: number; // 0..100
  poolDepth: bigint; // pool_yay + pool_nay
};

export function OpinionList() {
  const navigate = useNavigate();
  const [list, setList] = useState<OpinionEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Quick-jump form
  const [jumpHandle, setJumpHandle] = useState("");
  const [jumpSeq, setJumpSeq] = useState("");
  const [jumpErr, setJumpErr] = useState<string | null>(null);
  const [jumping, setJumping] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setList(null);
    (async () => {
      try {
        // Resolve curated handles → PIDs
        const profiles = (
          await Promise.all(
            CURATED_HANDLES.map(async (h) => {
              try {
                const w = await handleToWallet(rpc, h);
                if (!w) return null;
                const pid = await deriveProfileAddress(rpc, w);
                return { handle: h, pid };
              } catch {
                return null;
              }
            }),
          )
        ).filter((x): x is { handle: string; pid: string } => x !== null);

        // Fetch mints per profile + filter by market_exists
        const buckets = await Promise.all(
          profiles.map(async (p) => {
            try {
              const entries = await loadRecentHistory(rpc, p.pid, PER_PROFILE_LIMIT);
              const mintEntries = entries.filter(
                (e) =>
                  e.verb === VERB.MINT || e.verb === VERB.VOICE || e.verb === VERB.REMIX,
              );
              const decoded: { e: typeof mintEntries[0]; d: DecodedMint }[] = [];
              for (const e of mintEntries) {
                const d = decodeMintPayload(e.payloadHex);
                if (d) decoded.push({ e, d });
              }
              // For each decoded mint, check market_exists in parallel
              const checks = await Promise.all(
                decoded.map(async ({ d }) => ({
                  d,
                  ok: await marketExists(rpc, d.author, d.seq).catch(() => false),
                })),
              );
              const opinionMints = checks.filter((c) => c.ok).map((c) => c.d);
              return { ...p, mints: opinionMints };
            } catch {
              return { ...p, mints: [] };
            }
          }),
        );

        // Hydrate each opinion-mint with belief % + pool depth
        const entries: OpinionEntry[] = [];
        for (const b of buckets) {
          for (const m of b.mints) {
            try {
              const r = await poolReserves(rpc, m.author, m.seq);
              const denom = r.yay + r.nay;
              const beliefYay = denom > 0n ? Number((r.nay * 10000n) / denom) / 100 : 50;
              entries.push({
                authorHandle: b.handle,
                authorPid: m.author,
                seq: m.seq,
                contentText: m.contentText,
                beliefYay,
                poolDepth: denom,
              });
            } catch { /* skip */ }
          }
        }
        // Sort by pool depth desc (more liquid markets first)
        entries.sort((a, b) => (b.poolDepth > a.poolDepth ? 1 : b.poolDepth < a.poolDepth ? -1 : 0));

        if (cancelled) return;
        setList(entries);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message ?? String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Build a flat dropdown source from the resolved list — handle#seq labels
  const dropdownOptions = useMemo(() => {
    if (!list) return [];
    return list.map((e) => ({
      key: `${e.authorPid}-${e.seq}`,
      label: `@${e.authorHandle} #${e.seq} — ${e.contentText.slice(0, 60)}${e.contentText.length > 60 ? "…" : ""}`,
      pid: e.authorPid,
      seq: e.seq,
    }));
  }, [list]);

  async function quickJump() {
    setJumpErr(null);
    const h = jumpHandle.trim().replace(/^@/, "").toLowerCase();
    const s = Number(jumpSeq.trim());
    if (!h) { setJumpErr("Enter a handle."); return; }
    if (!Number.isFinite(s) || s < 0) { setJumpErr("Seq must be a non-negative integer."); return; }
    setJumping(true);
    try {
      const w = await handleToWallet(rpc, h);
      if (!w) { setJumpErr(`@${h} not registered.`); return; }
      const pid = await deriveProfileAddress(rpc, w);
      const ok = await marketExists(rpc, pid, s);
      if (!ok) {
        setJumpErr(`@${h} #${s} has no opinion market.`);
        return;
      }
      navigate(`/desnet/social/opinion/${pid}/${s}`);
    } catch (e) {
      setJumpErr((e as Error).message ?? String(e));
    } finally {
      setJumping(false);
    }
  }

  return (
    <div>
      <div className="card">
        <h3>Opinion markets</h3>
        <p className="muted small">
          Belief markets attached to mints. Each mint can carry an always-open
          YAY/NAY market denominated in the author's <code>$creator_token</code>.
          List here is from curated handles ({CURATED_HANDLES.join(", ")}); for
          arbitrary markets, use quick-jump or the in-feed{" "}
          <Link to="/desnet/social/feeds">aggregated timeline</Link> badge.
        </p>

        {/* Quick-jump dropdown + manual entry */}
        <div className="field" style={{ marginTop: 12 }}>
          <span>Quick jump to a market</span>
          <select
            value=""
            onChange={(e) => {
              const opt = dropdownOptions.find((o) => o.key === e.target.value);
              if (opt) navigate(`/desnet/social/opinion/${opt.pid}/${opt.seq}`);
            }}
            style={{ width: "100%" }}
          >
            <option value="">— select from list —</option>
            {dropdownOptions.map((o) => (
              <option key={o.key} value={o.key}>{o.label}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <span>…or paste handle + seq</span>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              value={jumpHandle}
              onChange={(e) => setJumpHandle(e.target.value)}
              placeholder="handle (e.g. desnet)"
              style={{ flex: 1 }}
            />
            <input
              type="number"
              min="0"
              value={jumpSeq}
              onChange={(e) => setJumpSeq(e.target.value)}
              placeholder="seq"
              style={{ width: 80 }}
            />
            <button className="primary" onClick={quickJump} disabled={jumping}>
              {jumping ? "…" : "Go →"}
            </button>
          </div>
          {jumpErr && <small className="error">{jumpErr}</small>}
        </div>
      </div>

      {err && <p className="error">{err}</p>}
      {loading && <p className="muted">Loading opinion markets…</p>}
      {!loading && list !== null && list.length === 0 && (
        <p className="muted">No opinion markets found in curated set yet.</p>
      )}
      {!loading && list && list.length > 0 && (
        <div className="feed-list">
          {list.map((e) => (
            <Link
              key={`${e.authorPid}-${e.seq}`}
              to={`/desnet/social/opinion/${e.authorPid}/${e.seq}`}
              className="feed-row"
              style={{ display: "block", textDecoration: "none", color: "inherit", cursor: "pointer" }}
            >
              <div className="feed-meta">
                <span className="verb-badge" style={{ background: "#1a4480", color: "#fff" }}>
                  opinion
                </span>{" "}
                <span className="muted small">
                  @{e.authorHandle} #{e.seq}
                </span>
              </div>
              <div className="feed-text">{e.contentText}</div>
              <div style={{ marginTop: 6, display: "flex", gap: 12, fontSize: "0.9em" }}>
                <span>
                  <strong className="ok">{e.beliefYay.toFixed(1)}% YAY</strong>{" "}
                  /{" "}
                  <strong className="error">{(100 - e.beliefYay).toFixed(1)}% NAY</strong>
                </span>
                <span className="muted">pool {formatTokenAmount(e.poolDepth)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
