// Single-mint permalink page. URL: /desnet/p/:handle/m/:seq
//
// Resolves handle → pid, walks the PID's history chunks looking for an entry
// whose decoded MintEvent.seq matches the URL param, and renders that single
// mint with full action bar (Press, Voice, Remix, opinion-trade panel if
// applicable). The Walrus blob doesn't know about specific mints — same
// SPA shell handles every (handle, seq) pair. Data fetched at runtime against
// the live chain.

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { createRpcPool } from "../../chain/rpc-pool";
import { MintActionBar } from "../../components/MintActionBar";
import { useAddress } from "../../wallet/useConnect";
import { deriveProfileAddress, handleOfWallet, handleToWallet, validateHandle } from "../../chain/desnet/profile";
import {
  VERB,
  decodeMintPayload,
  loadRecentHistory,
  type DecodedMint,
  type HistoryEntry,
} from "../../chain/desnet/history";
import { marketExists } from "../../chain/desnet/opinion";
import { aptosAddrEq, b64encode, bytesToAddress, safeImageDataUrl, shortAddr } from "../../chain/desnet/format";

const rpc = createRpcPool("desnet-mint-permalink");

// Walk-back size — enough to find any mint on a small handle today. For
// PIDs with thousands of mints this would need a smarter (random-access)
// chunk-walker keyed on seq → chunk; future indexer-satellite work. We
// distinguish "definitely doesn't exist" (entire history walked, none
// matched) from "out of search budget" (hit the limit, mint may exist
// further back) so the user gets accurate copy.
const SEARCH_LIMIT = 1000;

type Resolved = {
  handle: string;
  wallet: string;
  pidAddr: string;
};

export function Mint() {
  const { handle, seq: seqParam } = useParams<{ handle: string; seq: string }>();
  const navigate = useNavigate();
  const myAddr = useAddress();

  const [author, setAuthor] = useState<Resolved | null>(null);
  const [authorMissing, setAuthorMissing] = useState(false);
  const [entry, setEntry] = useState<HistoryEntry | null>(null);
  const [decoded, setDecoded] = useState<DecodedMint | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [outOfBudget, setOutOfBudget] = useState(false);
  const [loading, setLoading] = useState(true);
  const [hasOpinion, setHasOpinion] = useState<boolean | null>(null);
  const [myPid, setMyPid] = useState<string | null>(null);
  const [myHandle, setMyHandle] = useState<string | null>(null);

  const seq = useMemo(() => {
    const n = Number(seqParam ?? NaN);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  }, [seqParam]);

  // Reject malformed handle URLs before any chain lookup. Mirrors the
  // gate ProfileShell.tsx applies — defense in depth against a
  // permalink shared with a tampered :handle segment.
  const handleErr = useMemo(() => (handle ? validateHandle(handle) : "missing"), [handle]);

  // Resolve handle → wallet → pid
  useEffect(() => {
    let cancelled = false;
    setAuthor(null);
    setAuthorMissing(false);
    if (!handle) return;
    (async () => {
      const wallet = await handleToWallet(rpc, handle);
      if (!wallet) {
        if (!cancelled) setAuthorMissing(true);
        return;
      }
      const pidAddr = await deriveProfileAddress(rpc, wallet);
      if (!cancelled) setAuthor({ handle, wallet, pidAddr });
    })();
    return () => {
      cancelled = true;
    };
  }, [handle]);

  // Resolve viewer's own PID + handle (gates Voice/Remix actions)
  useEffect(() => {
    let cancelled = false;
    if (!myAddr) {
      setMyPid(null);
      setMyHandle(null);
      return;
    }
    (async () => {
      const pid = await deriveProfileAddress(rpc, myAddr);
      if (cancelled) return;
      setMyPid(pid);
      // Reverse: lookup handle from wallet (best-effort; many wallets have none)
      const h = await handleOfWallet(rpc, myAddr).catch(() => null);
      if (!cancelled) setMyHandle(h);
    })();
    return () => {
      cancelled = true;
    };
  }, [myAddr]);

  // Find the specific mint by seq within the author's history chunks.
  useEffect(() => {
    let cancelled = false;
    setEntry(null);
    setDecoded(null);
    setNotFound(false);
    setOutOfBudget(false);
    if (!author || seq === null) return;
    setLoading(true);
    (async () => {
      try {
        const rows = await loadRecentHistory(rpc, author.pidAddr, SEARCH_LIMIT);
        if (cancelled) return;
        for (const e of rows) {
          if (e.verb !== VERB.MINT && e.verb !== VERB.VOICE && e.verb !== VERB.REMIX) continue;
          const d = decodeMintPayload(e.payloadHex);
          if (d && d.seq === seq) {
            setEntry(e);
            setDecoded(d);
            return;
          }
        }
        if (cancelled) return;
        // If we hit SEARCH_LIMIT we may not have walked far enough back —
        // the mint could exist beyond the budget. Distinguish from the
        // definite-not-found case (fewer rows than budget = full history
        // walked, nothing matched).
        if (rows.length >= SEARCH_LIMIT) setOutOfBudget(true);
        else setNotFound(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [author, seq]);

  // Detect opinion-mint via Pattern B (resource existence at deterministic addr)
  useEffect(() => {
    let cancelled = false;
    setHasOpinion(null);
    if (!decoded) return;
    marketExists(rpc, decoded.author, decoded.seq)
      .then((b) => !cancelled && setHasOpinion(b))
      .catch(() => !cancelled && setHasOpinion(false));
    return () => {
      cancelled = true;
    };
  }, [decoded]);

  if (seq === null) {
    return (
      <div className="card">
        <h2>Bad mint URL</h2>
        <p className="muted">Expected /desnet/p/:handle/m/:seq with a numeric seq.</p>
      </div>
    );
  }
  if (handleErr) {
    return (
      <div className="card">
        <h2>Invalid handle</h2>
        <p className="muted">
          <code>@{handle}</code> isn't a valid DeSNet handle ({handleErr}). Handles
          are lowercase a-z, digits, underscore, 1-64 bytes, must start with a letter.
        </p>
      </div>
    );
  }
  if (authorMissing) {
    return (
      <div className="card">
        <h2>@{handle} not found</h2>
        <p className="muted">
          This handle isn't registered. <Link to="/desnet/register">Claim it →</Link>
        </p>
      </div>
    );
  }
  if (!author || loading) return <div className="page-loading">Loading mint…</div>;
  if (outOfBudget) {
    return (
      <div className="card">
        <h2>Mint #{seq} is older than the search budget</h2>
        <p className="muted">
          @{author.handle}'s history exceeds the {SEARCH_LIMIT}-entry walk-back limit
          and seq #{seq} sits past the cutoff. The mint likely exists on chain — a
          full lookup needs an indexer satellite (planned for v0.5+). For now,{" "}
          <Link to={`/desnet/p/${author.handle}/post`}>browse @{author.handle}'s feed →</Link>
        </p>
      </div>
    );
  }
  if (notFound || !entry || !decoded) {
    return (
      <div className="card">
        <h2>Mint not found</h2>
        <p className="muted">
          @{author.handle} doesn't have a mint at seq #{seq}.{" "}
          <Link to={`/desnet/p/${author.handle}/post`}>Browse @{author.handle}'s feed →</Link>
        </p>
      </div>
    );
  }

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
    entry.verb === VERB.MINT ? "Mint" : entry.verb === VERB.VOICE ? "Voice" : "Remix";
  const isMyMint = !!myPid && aptosAddrEq(myPid, decoded.author);

  // Voice/Remix navigation: only enabled if viewer has a registered handle.
  const voiceRemix = myHandle
    ? {
        enabled: true,
        onClick: (mode: "voice" | "remix") => {
          navigate(
            `/desnet/p/${myHandle}/post?prefill_mode=${mode}` +
              `&prefill_author=${decoded.author}&prefill_seq=${decoded.seq}` +
              `&prefill_handle=${author.handle}`,
          );
        },
      }
    : {
        enabled: false,
        onClick: () => {},
        disabledTooltip: "Register a handle to voice/remix",
      };

  const permalink = `/desnet/p/${author.handle}/m/${decoded.seq}`;
  const fullUrl = typeof window !== "undefined" ? window.location.origin + permalink : permalink;

  return (
    <article className="feed-row" style={{ marginTop: 8 }}>
      <div className="feed-meta" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span>
          <span className="verb-badge">{verbName}</span>{" "}
          <span className="muted small">
            <Link to={`/desnet/p/${author.handle}/post`}>@{author.handle}</Link> ·{" "}
            <Link to={permalink}>#{decoded.seq}</Link> ·{" "}
            {new Date(entry.timestampSecs * 1000).toLocaleString()}
            {isMyMint && " · (you)"}
          </span>
        </span>
        {hasOpinion === true && (
          <span className="muted small">
            <Link to={`/desnet/social/opinion/${decoded.author}/${decoded.seq}`}>trade →</Link>
          </span>
        )}
      </div>

      <div className="feed-text" style={{ fontSize: 18, lineHeight: 1.45, marginTop: 6 }}>
        {decoded.contentText}
      </div>

      {inlineUrl && <img className="feed-media" src={inlineUrl} alt="inline media" />}
      {assetRefAddr && (
        <div className="muted small">
          Asset: <code>{shortAddr(assetRefAddr)}</code>
        </div>
      )}

      {decoded.tags.length > 0 && (
        <div className="feed-tags">
          {decoded.tags.map((t) => (
            <span key={t} className="tag">
              #{t}
            </span>
          ))}
        </div>
      )}

      <MintActionBar
        authorPid={decoded.author}
        seq={decoded.seq}
        authorHandle={author.handle}
        myPid={myPid}
        voiceRemix={voiceRemix}
      />

      <hr style={{ border: 0, borderTop: "1px solid #1a1a1a", margin: "16px 0" }} />
      <div className="muted small" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <span>Permalink:</span>
        <code>{fullUrl}</code>
        <button
          type="button"
          className="link"
          onClick={() => {
            if (typeof navigator !== "undefined" && navigator.clipboard) {
              navigator.clipboard.writeText(fullUrl).catch(() => {});
            }
          }}
        >
          copy
        </button>
        <button
          type="button"
          className="link"
          onClick={async () => {
            const text = decoded.contentText.slice(0, 200);
            const shareData = {
              title: `@${author.handle} on DeSNet`,
              text,
              url: fullUrl,
            };
            // Web Share API (mobile + Safari + some Chrome). Falls back to
            // an X/Twitter compose intent so desktop users still have a
            // one-click path. Both routes ultimately let the user post the
            // permalink elsewhere — we just choose whichever the platform
            // supports.
            if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
              try {
                await navigator.share(shareData);
                return;
              } catch {
                // user cancelled or share failed — fall through to twitter intent
              }
            }
            const tweet =
              `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}` +
              `&url=${encodeURIComponent(fullUrl)}`;
            if (typeof window !== "undefined") window.open(tweet, "_blank", "noopener,noreferrer");
          }}
          title="Share via system share sheet (mobile) or X/Twitter (desktop)"
        >
          share
        </button>
        <a
          href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(decoded.contentText.slice(0, 200))}&url=${encodeURIComponent(fullUrl)}`}
          target="_blank"
          rel="noopener noreferrer"
          title="Share to X / Twitter"
        >
          𝕏
        </a>
        <a
          href={`https://t.me/share/url?url=${encodeURIComponent(fullUrl)}&text=${encodeURIComponent(decoded.contentText.slice(0, 200))}`}
          target="_blank"
          rel="noopener noreferrer"
          title="Share to Telegram"
        >
          tg
        </a>
        <Link to={`/desnet/p/${author.handle}/post`}>← back to @{author.handle}'s feed</Link>
      </div>
    </article>
  );
}
