// Feeds — aggregated timeline across multiple PIDs.
//
// MVP scope: curated set of well-known handles (desnet, darbitex, aptos, apt, d).
// True "global" feed would need an indexer satellite; "sync feeds" would need
// a view fn returning the PidSyncSet contents (currently only `is_synced`
// per-pair). Both deferred — see TODO comments below.

import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createRpcPool } from "../../chain/rpc-pool";
import { MintActionBar } from "../../components/MintActionBar";
import { handleOfWallet } from "../../chain/desnet/profile";
import {
  deriveProfileAddress,
  handleToWallet,
} from "../../chain/desnet/profile";
import {
  VERB,
  decodeMintPayload,
  loadRecentHistory,
  type DecodedMint,
  type HistoryEntry,
} from "../../chain/desnet/history";
import { marketExists } from "../../chain/desnet/opinion";
import { isSynced } from "../../chain/desnet/link";
import { useAddress } from "../../wallet/useConnect";
import { aptosAddrEq, b64encode, bytesToAddress, safeImageDataUrl, shortAddr } from "../../chain/desnet/format";

const rpc = createRpcPool("desnet-feeds");

const CURATED_HANDLES = ["desnet", "darbitex", "aptos", "apt", "d"];
const PER_PROFILE_LIMIT = 12;

type AggregatedRow = {
  entry: HistoryEntry;
  decoded: DecodedMint;
  authorHandle: string;
  authorPid: string;
  hasOpinion: boolean | null; // null = not yet resolved
};

type FeedMode = "global" | "curated" | "sync";

export function Feeds() {
  const myAddr = useAddress();
  const [mode, setMode] = useState<FeedMode>("curated");
  const [rows, setRows] = useState<AggregatedRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Resolve curated handles → PIDs once
  const [pidIndex, setPidIndex] = useState<{ handle: string; pid: string }[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.all(
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
    ).then((arr) => {
      if (cancelled) return;
      setPidIndex(arr.filter((x): x is { handle: string; pid: string } => x !== null));
    });
    return () => { cancelled = true; };
  }, []);

  // My PID + handle for sync filter / Voice-Remix nav
  const [myPid, setMyPid] = useState<string | null>(null);
  const [myHandle, setMyHandle] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!myAddr) { setMyPid(null); setMyHandle(null); return; }
    deriveProfileAddress(rpc, myAddr).then((p) => { if (!cancelled) setMyPid(p); });
    handleOfWallet(rpc, myAddr).then((h) => { if (!cancelled) setMyHandle(h && h.length > 0 ? h : null); }).catch(() => {});
    return () => { cancelled = true; };
  }, [myAddr]);

  // Load + aggregate feed
  useEffect(() => {
    let cancelled = false;
    if (!pidIndex) return;
    setLoading(true);
    setErr(null);
    setRows(null);
    (async () => {
      try {
        // Global mode is a placeholder until an indexer satellite ships —
        // there's no on-chain view that returns "all registered handles" so
        // a true global feed needs off-chain enumeration. For now, surface
        // the limitation explicitly and short-circuit.
        if (mode === "global") {
          if (!cancelled) setRows([]);
          return;
        }
        // Determine which PIDs to include based on mode
        let activePids: { handle: string; pid: string }[];
        if (mode === "sync") {
          if (!myPid) {
            // Wallet not connected → sync mode shows nothing
            if (!cancelled) setRows([]);
            return;
          }
          // Filter curated to ones the user has synced
          const checks = await Promise.all(
            pidIndex.map(async (p) => ({
              ...p,
              synced: await isSynced(rpc, myPid, p.pid).catch(() => false),
            })),
          );
          activePids = checks.filter((c) => c.synced);
          if (activePids.length === 0) {
            if (!cancelled) setRows([]);
            return;
          }
        } else {
          activePids = pidIndex;
        }

        // Fetch each PID's recent history in parallel
        const buckets = await Promise.all(
          activePids.map(async (p) => {
            try {
              const entries = await loadRecentHistory(rpc, p.pid, PER_PROFILE_LIMIT);
              return { ...p, entries };
            } catch {
              return { ...p, entries: [] };
            }
          }),
        );

        // Decode mints + check opinion market existence; flatten + sort by timestamp desc
        const out: AggregatedRow[] = [];
        for (const b of buckets) {
          for (const e of b.entries) {
            if (e.verb === VERB.MINT || e.verb === VERB.VOICE || e.verb === VERB.REMIX) {
              const decoded = decodeMintPayload(e.payloadHex);
              if (!decoded) continue;
              out.push({
                entry: e,
                decoded,
                authorHandle: b.handle,
                authorPid: b.pid,
                hasOpinion: null,
              });
            }
          }
        }
        out.sort((a, b) => b.entry.timestampSecs - a.entry.timestampSecs);

        if (cancelled) return;
        setRows(out);

        // Resolve market_exists for each (parallel, fire-and-forget update)
        out.forEach(async (row, idx) => {
          try {
            const ok = await marketExists(rpc, row.decoded.author, row.decoded.seq);
            if (cancelled) return;
            setRows((cur) => {
              if (!cur) return cur;
              const copy = cur.slice();
              if (copy[idx]) copy[idx] = { ...copy[idx], hasOpinion: ok };
              return copy;
            });
          } catch { /* ignore */ }
        });
      } catch (e) {
        if (!cancelled) setErr((e as Error).message ?? String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [pidIndex, mode, myPid]);

  return (
    <div>
      <div className="card">
        <h3>Aggregated timeline</h3>
        <p className="muted small">
          Pulls the most recent {PER_PROFILE_LIMIT} mints from each curated PID + sorts by timestamp.
          Opinion-mints get a "trade →" badge inline. (Real global feed needs an indexer satellite —
          not in v0.4. Sync feed currently filters curated set to PIDs you've synced.)
        </p>
        <div className="subnav">
          <button
            type="button"
            className={mode === "global" ? "active" : ""}
            onClick={() => setMode("global")}
            title="All registered handles — needs indexer satellite (not in v0.4)"
          >
            Global
          </button>
          <button
            type="button"
            className={mode === "curated" ? "active" : ""}
            onClick={() => setMode("curated")}
          >
            Curated ({CURATED_HANDLES.length})
          </button>
          <button
            type="button"
            className={mode === "sync" ? "active" : ""}
            onClick={() => setMode("sync")}
            disabled={!myAddr}
            title={!myAddr ? "Connect a wallet to use sync filter" : undefined}
          >
            Sync
          </button>
        </div>
      </div>

      {err && <p className="error">{err}</p>}
      {loading && <p className="muted">Loading…</p>}
      {!loading && rows !== null && rows.length === 0 && (
        <p className="muted">
          {mode === "global" && (
            <>
              <strong>Global feed needs an indexer satellite</strong> — the
              on-chain protocol doesn't expose "all registered handles" as a
              single view (intentional: keeps the chain lean). v0.5 backlog.
              For now use <strong>Curated</strong> (5 well-known handles) or{" "}
              <strong>Sync</strong> (filter to PIDs you've synced).
            </>
          )}
          {mode === "sync" &&
            "You haven't synced any of the curated PIDs yet. Visit a profile and click 'sync' on it."}
          {mode === "curated" && "No mints yet from the curated set."}
        </p>
      )}
      {!loading && rows && rows.length > 0 && (
        <div className="feed-list">
          {rows.map((row, i) => (
            <FeedAggregatedRow
              key={`${row.entry.chunkAddr}-${row.entry.idx}-${i}`}
              row={row}
              myPid={myPid}
              myHandle={myHandle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FeedAggregatedRow({
  row,
  myPid,
  myHandle,
}: {
  row: AggregatedRow;
  myPid: string | null;
  myHandle: string | null;
}) {
  const navigate = useNavigate();
  const { decoded, authorHandle } = row;
  const inline = decoded.media?.kind === 1 ? decoded.media : null;
  const inlineUrl =
    inline && inline.inlineData.length > 0
      ? safeImageDataUrl(b64encode(inline.inlineData), inline.mimeName)
      : null;
  const assetRefAddr =
    decoded.media?.kind === 2 && decoded.media.refBackend === 3
      ? bytesToAddress(decoded.media.refBlobId)
      : null;
  const verbName =
    row.entry.verb === VERB.MINT ? "Mint" : row.entry.verb === VERB.VOICE ? "Voice" : "Remix";
  const isMyMint = !!myPid && aptosAddrEq(myPid, decoded.author);

  // Voice/Remix navigation: only enabled if viewer has a registered handle.
  // Navigates to viewer's own /post page with URL params Compose reads on mount.
  const voiceRemix = myHandle
    ? {
        enabled: true,
        onClick: (mode: "voice" | "remix") => {
          navigate(
            `/desnet/p/${myHandle}/post?prefill_mode=${mode}` +
              `&prefill_author=${decoded.author}&prefill_seq=${decoded.seq}` +
              `&prefill_handle=${authorHandle}`,
          );
        },
      }
    : {
        enabled: false,
        onClick: () => {},
        disabledTooltip: "Register a handle to voice/remix",
      };

  return (
    <div className="feed-row">
      <div className="feed-meta">
        <span className="verb-badge">{verbName}</span>{" "}
        <span className="muted small">
          <Link to={`/desnet/p/${authorHandle}/post`}>@{authorHandle}</Link> ·{" "}
          <Link to={`/desnet/p/${authorHandle}/m/${decoded.seq}`} className="permalink">#{decoded.seq}</Link> ·{" "}
          <Link to={`/desnet/p/${authorHandle}/m/${decoded.seq}`} className="permalink">
            {new Date(row.entry.timestampSecs * 1000).toLocaleString()}
          </Link>
          {isMyMint && " · (you)"}
        </span>
      </div>
      <div className="feed-text">{decoded.contentText}</div>
      {inlineUrl && <img className="feed-media" src={inlineUrl} alt="inline media" />}
      {assetRefAddr && (
        <div className="muted small">
          Asset: <code>{shortAddr(assetRefAddr)}</code>
        </div>
      )}
      {decoded.tags.length > 0 && (
        <div className="feed-tags">
          {decoded.tags.map((t) => <span key={t} className="tag">#{t}</span>)}
        </div>
      )}
      <MintActionBar
        authorPid={decoded.author}
        seq={decoded.seq}
        authorHandle={authorHandle}
        myPid={myPid}
        voiceRemix={voiceRemix}
      />
    </div>
  );
}
