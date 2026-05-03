import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useAddress } from "../../wallet/useConnect";
import { fetchFaBalance } from "../../chain/balance";
import { createRpcPool } from "../../chain/rpc-pool";
import {
  CREATE_MINT_FN,
  buildCreateMintArgs,
  mimeName,
  mimeOfFile,
  nextSeq,
} from "../../chain/desnet/mint";
import { handleOf, handleToWallet, deriveProfileAddress } from "../../chain/desnet/profile";
import { tokenMetadataAddr } from "../../chain/desnet/amm";
import {
  ECHO_FN,
  SPARK_FN,
  echoArgs,
  sparkArgs,
} from "../../chain/desnet/pulse";
import {
  ENABLE_PRESS_FN,
  PRESS_FN,
  enablePressArgs,
  hasPressed,
  isPressEnabled,
  pressArgs,
  pressedCount,
} from "../../chain/desnet/press";
import {
  VERB,
  decodeMintPayload,
  loadRecentHistory,
  type DecodedMint,
  type HistoryEntry,
} from "../../chain/desnet/history";
import {
  detectTier,
  getOrchestratorByTier,
  tierLabel,
  tierTxCount,
  type OrchestratorTier,
  type UploadProgress,
} from "../../chain/desnet/assetsOrchestrator";
import { CHUNK_SIZE_MAX, MAX_TOTAL_SIZE } from "../../chain/desnet/assets";
import type { MoveArg, MoveFn } from "../../chain/desnet/tx";
import {
  aptosAddrEq,
  b64encode,
  bytesToAddress,
  safeImageDataUrl,
  shortAddr,
} from "../../chain/desnet/format";

const rpc = createRpcPool("desnet-feed");

const FEED_LIMIT = 30;
const INLINE_MAX_BYTES = 8 * 1024;
const CONTENT_MAX_BYTES = 333;

type ResolvedAuthor = {
  handle: string;
  pidAddr: string;
  wallet: string;
};

export function Feed() {
  const { handle } = useParams<{ handle: string }>();
  const myAddr = useAddress();

  const [author, setAuthor] = useState<ResolvedAuthor | null>(null);
  const [authorMissing, setAuthorMissing] = useState(false);
  const [myPid, setMyPid] = useState<string | null>(null);
  const [feed, setFeed] = useState<HistoryEntry[]>([]);
  const [loadingFeed, setLoadingFeed] = useState(false);
  const [feedTick, setFeedTick] = useState(0);

  // Resolve handle → wallet → pidAddr
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

  // Resolve my own PID — needed both for compose visibility check and verb actions
  useEffect(() => {
    let cancelled = false;
    if (!myAddr) {
      setMyPid(null);
      return;
    }
    deriveProfileAddress(rpc, myAddr).then((pid) => {
      if (!cancelled) setMyPid(pid);
    });
    return () => {
      cancelled = true;
    };
  }, [myAddr]);

  // Load feed for this profile
  useEffect(() => {
    let cancelled = false;
    if (!author) {
      setFeed([]);
      return;
    }
    setLoadingFeed(true);
    loadRecentHistory(rpc, author.pidAddr, FEED_LIMIT)
      .then((rows) => {
        if (!cancelled) setFeed(rows);
      })
      .finally(() => {
        if (!cancelled) setLoadingFeed(false);
      });
    return () => {
      cancelled = true;
    };
  }, [author, feedTick]);

  const isMyProfile = !!(
    myAddr &&
    author &&
    myAddr.toLowerCase() === author.wallet.toLowerCase()
  );

  if (authorMissing) {
    return (
      <div className="card">
        <h2>@{handle} not found</h2>
        <p className="muted">
          This handle isn't registered. <a href="/desnet/register">Claim it →</a>
        </p>
      </div>
    );
  }
  if (!author) return <div className="page-loading">Loading…</div>;

  return (
    <>
      {isMyProfile && (
        <Compose
          authorPid={author.pidAddr}
          onPosted={() => setFeedTick((t) => t + 1)}
        />
      )}
      {!isMyProfile && myAddr && (
        <p className="muted small">
          Compose box hidden — you're viewing @{author.handle}'s feed. Switch to
          your own profile to post.
        </p>
      )}

      <h3>Feed</h3>
      {loadingFeed ? (
        <p className="muted">Loading entries…</p>
      ) : feed.length === 0 ? (
        <p className="muted">No on-chain history yet.</p>
      ) : (
        <div className="feed-list">
          {feed.map((e) => (
            <FeedRow
              key={`${e.chunkAddr}-${e.idx}`}
              entry={e}
              myPid={myPid}
              authorHandle={author.handle}
            />
          ))}
        </div>
      )}
    </>
  );
}

// ============ Compose ============

type ComposeMode = "original" | "voice" | "remix";

type Ref = { author: string; seq: number; handle: string };

function Compose({ authorPid, onPosted }: { authorPid: string; onPosted: () => void }) {
  const { signAndSubmitTransaction } = useWallet();

  const [text, setText] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [mediaMode, setMediaMode] = useState<"none" | "inline" | "asset">("none");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ============ Voice / Remix mode ============
  const [composeMode, setComposeMode] = useState<ComposeMode>("original");
  const [refInput, setRefInput] = useState("");
  const [resolvedRef, setResolvedRef] = useState<Ref | null>(null);
  const [refError, setRefError] = useState<string | null>(null);
  const [refResolving, setRefResolving] = useState(false);

  useEffect(() => {
    setResolvedRef(null);
    setRefError(null);
    if (composeMode === "original" || !refInput.trim()) return;
    let cancelled = false;
    setRefResolving(true);
    const t = setTimeout(async () => {
      try {
        const ref = await resolveRef(refInput.trim());
        if (cancelled) return;
        if (!ref) {
          setRefError("Format: @handle#seq or 0xPID#seq");
          return;
        }
        setResolvedRef(ref);
      } catch (e) {
        if (!cancelled) setRefError((e as Error).message ?? "Resolution failed");
      } finally {
        if (!cancelled) setRefResolving(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [refInput, composeMode]);

  // ============ Mentions / Tickers ============
  const [mentionsInput, setMentionsInput] = useState("");
  const [tickersInput, setTickersInput] = useState("");
  const [mentions, setMentions] = useState<{ raw: string; resolved: string | null }[]>([]);
  const [tickers, setTickers] = useState<{ raw: string; resolved: string | null }[]>([]);

  useEffect(() => {
    let cancelled = false;
    const handles = parseList(mentionsInput).slice(0, 10);
    if (handles.length === 0) {
      setMentions([]);
      return;
    }
    Promise.all(
      handles.map(async (raw) => {
        const wallet = await handleToWallet(rpc, raw.replace(/^@/, ""));
        return { raw, resolved: wallet };
      }),
    ).then((rows) => {
      if (!cancelled) setMentions(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [mentionsInput]);

  useEffect(() => {
    let cancelled = false;
    const handles = parseList(tickersInput).slice(0, 5);
    if (handles.length === 0) {
      setTickers([]);
      return;
    }
    Promise.all(
      handles.map(async (raw) => {
        const handle = raw.replace(/^\$/, "").toLowerCase();
        const wallet = await handleToWallet(rpc, handle);
        if (!wallet) return { raw, resolved: null };
        try {
          // factory-token validation: pool must exist for handle
          await tokenMetadataAddr(rpc, handle);
          const pid = await deriveProfileAddress(rpc, wallet);
          return { raw, resolved: pid };
        } catch {
          return { raw, resolved: null };
        }
      }),
    ).then((rows) => {
      if (!cancelled) setTickers(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [tickersInput]);

  // ============ Tips ============
  type TipRow = {
    recipientInput: string; // handle or 0x addr
    tokenHandleInput: string; // "" = APT, "alice" = $alice
    amountInput: string;
    resolvedRecipient: string | null;
    resolvedTokenMeta: string | null;
  };
  const [tipRows, setTipRows] = useState<TipRow[]>([]);

  // Latest-tipRows snapshot for the resolver effect to read without putting
  // the whole `tipRows` array in deps (which would re-fire the resolver on
  // every resolved-field write → infinite loop). The dep is a key derived
  // ONLY from raw user inputs.
  const tipRowsRef = useRef(tipRows);
  useEffect(() => { tipRowsRef.current = tipRows; }, [tipRows]);

  const tipRowsKey = useMemo(
    () => tipRows.map((r) => `${r.recipientInput}\0${r.tokenHandleInput}`).join("|"),
    [tipRows],
  );

  // Resolve every row's recipient/token whenever inputs change.
  useEffect(() => {
    let cancelled = false;
    const rows = tipRowsRef.current;
    Promise.all(
      rows.map(async (row, idx) => {
        const recipient = row.recipientInput.trim();
        let resolvedRecipient: string | null = null;
        if (recipient.startsWith("0x")) {
          resolvedRecipient = recipient;
        } else if (recipient) {
          resolvedRecipient = await handleToWallet(rpc, recipient.replace(/^@/, ""));
        }
        const tokenHandle = row.tokenHandleInput.trim().replace(/^\$/, "");
        let resolvedTokenMeta: string | null = null;
        if (!tokenHandle) {
          // APT FA — canonical 0xa with leading zeros
          resolvedTokenMeta = "0x000000000000000000000000000000000000000000000000000000000000000a";
        } else {
          try {
            resolvedTokenMeta = await tokenMetadataAddr(rpc, tokenHandle.toLowerCase());
          } catch {
            resolvedTokenMeta = null;
          }
        }
        return { idx, resolvedRecipient, resolvedTokenMeta };
      }),
    ).then((updates) => {
      if (cancelled) return;
      setTipRows((cur) =>
        cur.map((r, i) => {
          const u = updates.find((x) => x.idx === i);
          return u
            ? { ...r, resolvedRecipient: u.resolvedRecipient, resolvedTokenMeta: u.resolvedTokenMeta }
            : r;
        }),
      );
    });
    return () => { cancelled = true; };
  }, [tipRowsKey]);

  // L3: per-token tip balance map. Tips are withdrawn from the connected
  // wallet's primary store, so we read balances against `myWallet`. Map key
  // is the FA metadata addr; grouping happens automatically by Map dedupe.
  const myWallet = useAddress();
  const [tipBalances, setTipBalances] = useState<Map<string, bigint>>(new Map());
  const tipMetasKey = useMemo(
    () => tipRows.map((r) => r.resolvedTokenMeta ?? "").filter(Boolean).join(","),
    [tipRows],
  );
  useEffect(() => {
    let cancelled = false;
    if (!myWallet) {
      setTipBalances(new Map());
      return;
    }
    const metas = Array.from(new Set(
      tipRows.map((r) => r.resolvedTokenMeta).filter((x): x is string => !!x),
    ));
    if (metas.length === 0) {
      setTipBalances(new Map());
      return;
    }
    Promise.all(
      metas.map(async (meta) => {
        try {
          return [meta, await fetchFaBalance(myWallet, meta)] as const;
        } catch {
          return [meta, 0n] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setTipBalances(new Map(entries));
    });
    return () => { cancelled = true; };
  }, [tipMetasKey, myWallet]);

  // Insufficient-tip detection: sum amounts per resolved token, compare
  // against connected wallet balance. Used to render row-level red badge
  // and gate submit. Dedup pre-summing — multiple rows for same token sum.
  const tipInsufficient = useMemo(() => {
    const summed = new Map<string, bigint>();
    for (const r of tipRows) {
      if (!r.resolvedTokenMeta) continue;
      const amt = Math.floor(Number(r.amountInput) * 1e8);
      if (!Number.isFinite(amt) || amt <= 0) continue;
      summed.set(
        r.resolvedTokenMeta,
        (summed.get(r.resolvedTokenMeta) ?? 0n) + BigInt(amt),
      );
    }
    const insufficient = new Set<string>();
    for (const [meta, total] of summed) {
      const bal = tipBalances.get(meta) ?? 0n;
      if (total > bal) insufficient.add(meta);
    }
    return insufficient;
  }, [tipRows, tipBalances]);

  // Live capability — what the on-chain bytecode currently supports. Higher
  // tiers stay disabled in the picker until the corresponding Move upgrade
  // ships and `assets::orchestrator_tier()` returns ≥ that number.
  const [maxTier, setMaxTier] = useState<OrchestratorTier | null>(null);
  // User pick — defaults to maxTier on first load.
  const [pickedTier, setPickedTier] = useState<OrchestratorTier>(1);
  useEffect(() => {
    detectTier(rpc).then((t) => {
      setMaxTier(t);
      setPickedTier(t);
    });
  }, []);

  const textBytes = useMemo(() => new TextEncoder().encode(text).length, [text]);
  const tags = useMemo(
    () =>
      tagsInput
        .split(/[, ]+/)
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 5),
    [tagsInput],
  );

  const fileMime = file ? mimeOfFile(file) : null;
  const fileSize = file ? file.size : 0;
  const inlineOk = mediaMode === "inline" && file && fileMime != null && fileSize <= INLINE_MAX_BYTES;
  const assetOk = mediaMode === "asset" && file && fileMime != null && fileSize <= MAX_TOTAL_SIZE;
  const noMedia = mediaMode === "none";

  const expectedTxCount =
    mediaMode === "asset" && file && fileMime != null
      ? // upload tx count + 1 final create_mint tx
        tierTxCount(pickedTier, { chunks: Math.ceil(fileSize / CHUNK_SIZE_MAX) }) + 1
      : 1;

  const refOk = composeMode === "original" || (resolvedRef !== null && !refResolving);
  const tipsOk = tipRows.every(
    (r) => r.resolvedRecipient && r.resolvedTokenMeta && Number(r.amountInput) > 0,
  );
  const tipsAffordable = tipInsufficient.size === 0;
  const canPost =
    !!text.trim() &&
    textBytes <= CONTENT_MAX_BYTES &&
    (noMedia || inlineOk || assetOk) &&
    refOk &&
    tipsOk &&
    tipsAffordable &&
    !submitting;

  async function readFileBytes(f: File): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(new Uint8Array(fr.result as ArrayBuffer));
      fr.onerror = () => reject(fr.error);
      fr.readAsArrayBuffer(f);
    });
  }

  async function submit() {
    setError(null);
    setLastTx(null);
    setProgress(null);
    setSubmitting(true);
    try {
      let assetMasterAddr: string | null = null;
      let inline: { mime: number; bytes: Uint8Array } | null = null;

      if (mediaMode === "inline" && file && fileMime != null) {
        inline = { mime: fileMime, bytes: await readFileBytes(file) };
      } else if (mediaMode === "asset" && file && fileMime != null) {
        const orch = getOrchestratorByTier(pickedTier);
        const bytes = await readFileBytes(file);
        // Lazy import the Aptos client off the rpc pool (its `primary` field).
        const aptos = rpc.primary;
        const res = await orch.upload({
          bytes,
          mime: fileMime,
          creatorPid: authorPid,
          submit: signAndSubmitTransaction as Parameters<typeof orch.upload>[0]["submit"],
          aptos,
          onProgress: setProgress,
        });
        assetMasterAddr = res.masterAddr;
      }

      const parent =
        composeMode === "voice" && resolvedRef
          ? { author: resolvedRef.author, seq: resolvedRef.seq }
          : null;
      const quote =
        composeMode === "remix" && resolvedRef
          ? { author: resolvedRef.author, seq: resolvedRef.seq }
          : null;

      const mentionAddrs = mentions
        .map((m) => m.resolved)
        .filter((x): x is string => !!x);
      const tickerPids = tickers
        .map((t) => t.resolved)
        .filter((x): x is string => !!x);
      const tipPayload = tipRows
        .filter((r) => r.resolvedRecipient && r.resolvedTokenMeta && Number(r.amountInput) > 0)
        .map((r) => ({
          recipient: r.resolvedRecipient!,
          tokenMetadata: r.resolvedTokenMeta!,
          amount: BigInt(Math.floor(Number(r.amountInput) * 1e8)), // 8 decimals (APT + every $TOKEN)
        }));

      const args = buildCreateMintArgs({
        contentText: text,
        inline,
        assetMasterAddr,
        tags,
        parent,
        quote,
        mentions: mentionAddrs,
        tickers: tickerPids,
        tips: tipPayload,
      });
      const result = await signAndSubmitTransaction({
        data: { function: CREATE_MINT_FN, typeArguments: [], functionArguments: args },
      });
      setLastTx(result.hash);
      setText("");
      setTagsInput("");
      setFile(null);
      setMediaMode("none");
      setProgress(null);
      setComposeMode("original");
      setRefInput("");
      setMentionsInput("");
      setTickersInput("");
      setTipRows([]);
      onPosted();
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card compose-card">
      <h3>Compose Mint</h3>

      <fieldset className="lock-pick">
        <legend>Mode</legend>
        <label>
          <input
            type="radio"
            checked={composeMode === "original"}
            onChange={() => setComposeMode("original")}
          />{" "}
          Original Mint
        </label>
        <label>
          <input
            type="radio"
            checked={composeMode === "voice"}
            onChange={() => setComposeMode("voice")}
          />{" "}
          Voice (reply to a mint)
        </label>
        <label>
          <input
            type="radio"
            checked={composeMode === "remix"}
            onChange={() => setComposeMode("remix")}
          />{" "}
          Remix (quote a mint)
        </label>
      </fieldset>

      {composeMode !== "original" && (
        <label className="field">
          <span>{composeMode === "voice" ? "Reply to" : "Quoting"}</span>
          <input
            value={refInput}
            onChange={(e) => setRefInput(e.target.value)}
            placeholder="@alice#3 or 0xPID#3"
          />
          <small>
            {refResolving && "Resolving…"}
            {!refResolving && resolvedRef && (
              <span className="ok">
                ✓ @{resolvedRef.handle} #{resolvedRef.seq} (pid{" "}
                {shortAddr(resolvedRef.author)})
              </span>
            )}
            {!refResolving && refError && <span className="error">{refError}</span>}
          </small>
        </label>
      )}

      <textarea
        rows={3}
        maxLength={500}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What's on chain?"
      />
      <small className={textBytes > CONTENT_MAX_BYTES ? "error" : "muted"}>
        {textBytes} / {CONTENT_MAX_BYTES} bytes
      </small>

      <label className="field">
        <span>Tags (max 5, comma-separated)</span>
        <input
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
          placeholder="aptos, defi, art"
        />
      </label>

      <label className="field">
        <span>Mentions (max 10, @handle, comma-separated)</span>
        <input
          value={mentionsInput}
          onChange={(e) => setMentionsInput(e.target.value)}
          placeholder="@alice, @bob"
        />
        {mentions.length > 0 && (
          <small>
            {mentions.map((m, i) => (
              <span
                key={i}
                className={m.resolved ? "ok" : "error"}
                style={{ marginRight: 8 }}
              >
                {m.resolved ? `${m.raw} → ${shortAddr(m.resolved)}` : `${m.raw} ✗ unknown`}
              </span>
            ))}
          </small>
        )}
      </label>

      <label className="field">
        <span>Tickers (max 5, $handle, comma-separated)</span>
        <input
          value={tickersInput}
          onChange={(e) => setTickersInput(e.target.value)}
          placeholder="$alice, $desnet"
        />
        {tickers.length > 0 && (
          <small>
            {tickers.map((t, i) => (
              <span
                key={i}
                className={t.resolved ? "ok" : "error"}
                style={{ marginRight: 8 }}
              >
                {t.resolved
                  ? `${t.raw} → pid ${shortAddr(t.resolved)}`
                  : `${t.raw} ✗ not a factory token`}
              </span>
            ))}
          </small>
        )}
      </label>

      <fieldset className="lock-pick">
        <legend>Tips (max 10)</legend>
        {tipRows.length === 0 && <p className="muted small">No tips. Click + to add.</p>}
        {tipRows.map((row, i) => (
          <div
            key={i}
            style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr auto", gap: 6, marginBottom: 6 }}
          >
            <input
              value={row.recipientInput}
              onChange={(e) =>
                setTipRows((rows) =>
                  rows.map((r, j) => (j === i ? { ...r, recipientInput: e.target.value } : r)),
                )
              }
              placeholder="@handle or 0x…"
            />
            <input
              value={row.tokenHandleInput}
              onChange={(e) =>
                setTipRows((rows) =>
                  rows.map((r, j) => (j === i ? { ...r, tokenHandleInput: e.target.value } : r)),
                )
              }
              placeholder="APT or $alice"
            />
            <input
              type="number"
              min="0"
              step="any"
              value={row.amountInput}
              onChange={(e) =>
                setTipRows((rows) =>
                  rows.map((r, j) => (j === i ? { ...r, amountInput: e.target.value } : r)),
                )
              }
              placeholder="0.0"
            />
            <button
              className="link"
              onClick={() => setTipRows((rows) => rows.filter((_, j) => j !== i))}
              type="button"
              aria-label="Remove tip"
            >
              ×
            </button>
          </div>
        ))}
        {tipRows.length < 10 && (
          <button
            className="link"
            onClick={() =>
              setTipRows((rows) => [
                ...rows,
                {
                  recipientInput: "",
                  tokenHandleInput: "",
                  amountInput: "",
                  resolvedRecipient: null,
                  resolvedTokenMeta: null,
                },
              ])
            }
            type="button"
          >
            + add tip
          </button>
        )}
        {tipRows.length > 0 && !tipsOk && (
          <small className="error">Each tip needs a resolved recipient, token, and positive amount.</small>
        )}
        {tipInsufficient.size > 0 && (
          <small className="error">
            Insufficient balance for {tipInsufficient.size} token
            {tipInsufficient.size > 1 ? "s" : ""}. Tx would revert.
          </small>
        )}
      </fieldset>

      <fieldset className="lock-pick">
        <legend>Media</legend>
        <label>
          <input type="radio" checked={mediaMode === "none"} onChange={() => setMediaMode("none")} />{" "}
          None
        </label>
        <label>
          <input type="radio" checked={mediaMode === "inline"} onChange={() => setMediaMode("inline")} />{" "}
          Inline (≤ 8 KB) — 1 tx
        </label>
        <label>
          <input type="radio" checked={mediaMode === "asset"} onChange={() => setMediaMode("asset")} />{" "}
          On-chain asset (≤ 5 MB)
        </label>
      </fieldset>

      {mediaMode === "asset" && (
        <fieldset className="lock-pick">
          <legend>Upload tier</legend>
          {([1, 2, 3] as OrchestratorTier[]).map((t) => {
            const meta = tierLabel(t);
            const supported = maxTier !== null && t <= maxTier;
            return (
              <label key={t} className={supported ? "" : "muted"} title={meta.description}>
                <input
                  type="radio"
                  name="upload-tier"
                  checked={pickedTier === t}
                  disabled={!supported}
                  onChange={() => setPickedTier(t)}
                />{" "}
                <strong>{meta.name}</strong> ({meta.short})
                {!supported && <span className="small"> — not yet on chain</span>}
                <div className="muted small" style={{ marginLeft: 22 }}>
                  {meta.description}
                </div>
              </label>
            );
          })}
          {maxTier !== null && (
            <p className="muted small">
              On-chain bytecode currently supports up to <strong>Tier {maxTier}</strong>.
              Higher tiers auto-enable when the corresponding{" "}
              <code>assets.move</code> upgrade ships.
            </p>
          )}
        </fieldset>
      )}

      {mediaMode !== "none" && (
        <label className="field">
          <span>Image file</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          {file && (
            <small className={fileMime == null ? "error" : "muted"}>
              {file.name} · {(fileSize / 1024).toFixed(1)} KB · {file.type}
              {fileMime != null && ` · ${mimeName(fileMime)}`}
              {mediaMode === "inline" && fileSize > INLINE_MAX_BYTES && (
                <span className="error"> — exceeds 8 KB inline cap. Switch to asset mode.</span>
              )}
              {mediaMode === "asset" && fileSize > MAX_TOTAL_SIZE && (
                <span className="error"> — exceeds 5 MB max.</span>
              )}
            </small>
          )}
        </label>
      )}

      {mediaMode === "asset" && file && fileMime != null && (
        <p className="muted small">
          Will run <strong>{expectedTxCount}</strong> wallet confirmations
          (asset upload + final mint). Each step explains what it's doing.
        </p>
      )}

      <button className="primary" disabled={!canPost} onClick={submit}>
        {submitting ? "Posting…" : "Mint"}
      </button>

      {progress && (
        <div className="upload-progress">
          <div>{progress.hint}</div>
          <progress value={progress.step} max={progress.totalSteps}></progress>
          <small className="muted">
            {progress.step} / {progress.totalSteps}
            {progress.lastTxHash &&
              ` · last tx ${progress.lastTxHash.slice(0, 10)}…`}
          </small>
        </div>
      )}

      {lastTx && (
        <p className="ok">
          Posted.{" "}
          <a
            href={`https://explorer.aptoslabs.com/txn/${lastTx}?network=mainnet`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {lastTx.slice(0, 10)}…
          </a>
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

// ============ Feed row renderer ============

function FeedRow({
  entry,
  myPid,
  authorHandle,
}: {
  entry: HistoryEntry;
  myPid: string | null;
  authorHandle: string;
}) {
  const { signAndSubmitTransaction } = useWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);

  const decoded: DecodedMint | null = useMemo(
    () =>
      entry.verb === VERB.MINT || entry.verb === VERB.VOICE || entry.verb === VERB.REMIX
        ? decodeMintPayload(entry.payloadHex)
        : null,
    [entry],
  );

  // Press state — independent of decoding because hooks must run unconditionally.
  // Note: only meaningful when `decoded` is non-null. Defaults are safe no-ops.
  const [pressEnabled, setPressEnabled] = useState<boolean | null>(null);
  const [pressCount, setPressCount] = useState<number>(0);
  const [iPressed, setIPressed] = useState<boolean>(false);
  const [pressForm, setPressForm] = useState<{
    open: boolean;
    supplyCap: string;
    windowDays: string;
  }>({ open: false, supplyCap: "100", windowDays: "7" });

  useEffect(() => {
    let cancelled = false;
    if (!decoded) {
      setPressEnabled(null);
      return;
    }
    isPressEnabled(rpc, decoded.author, decoded.seq).then(async (en) => {
      if (cancelled) return;
      setPressEnabled(en);
      if (en) {
        const [count, mine] = await Promise.all([
          pressedCount(rpc, decoded.author, decoded.seq),
          myPid ? hasPressed(rpc, myPid, decoded.author, decoded.seq) : Promise.resolve(false),
        ]);
        if (cancelled) return;
        setPressCount(count);
        setIPressed(mine);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [decoded, myPid, refreshTick]);

  async function fire(fn: MoveFn, args: MoveArg[]) {
    setBusy(fn);
    setActionError(null);
    try {
      await signAndSubmitTransaction({
        data: { function: fn, typeArguments: [], functionArguments: args },
      });
      setRefreshTick((t) => t + 1);
    } catch (e) {
      setActionError(decodeWalletError(e, fn));
    } finally {
      setBusy(null);
    }
  }

  async function enablePress() {
    if (!decoded) return;
    const cap = Math.max(1, Math.min(1000, Number(pressForm.supplyCap) || 0));
    const days = Math.max(1, Math.min(7, Number(pressForm.windowDays) || 0));
    setBusy(ENABLE_PRESS_FN);
    setActionError(null);
    try {
      await signAndSubmitTransaction({
        data: {
          function: ENABLE_PRESS_FN,
          typeArguments: [],
          functionArguments: enablePressArgs(decoded.seq, cap, days),
        },
      });
      setPressForm((f) => ({ ...f, open: false }));
      setRefreshTick((t) => t + 1);
    } catch (e) {
      setActionError(decodeWalletError(e, ENABLE_PRESS_FN));
    } finally {
      setBusy(null);
    }
  }

  // Non-mint verbs render compact line items.
  if (!decoded) {
    return (
      <div className="feed-row feed-row-compact">
        <span className="verb-badge">{verbLabel(entry.verb)}</span>{" "}
        <span className="muted small">
          {new Date(entry.timestampSecs * 1000).toLocaleString()}
        </span>{" "}
        {entry.target && (
          <span className="mono small">→ {shortAddr(entry.target)}</span>
        )}
      </div>
    );
  }

  // Mint / Voice / Remix render full content + actions.
  const verbName =
    entry.verb === VERB.MINT ? "Mint" : entry.verb === VERB.VOICE ? "Voice" : "Remix";

  const inline = decoded.media?.kind === 1 ? decoded.media : null;
  // L1 hardening: route inline base64 through safeImageDataUrl, which strips
  // <script> + on*= handlers + javascript: URIs from SVG before encoding.
  const inlineUrl =
    inline && inline.inlineData.length > 0
      ? safeImageDataUrl(b64encode(inline.inlineData), inline.mimeName)
      : null;

  // Asset-ref media → master_addr stored in ref_blob_id (BCS bytes of address)
  const assetRefAddr =
    decoded.media?.kind === 2 && decoded.media.refBackend === 3
      ? bytesToAddress(decoded.media.refBlobId)
      : null;

  const canAct = !!myPid;
  const isAuthor = !!myPid && aptosAddrEq(myPid, decoded.author);

  return (
    <div className="feed-row">
      <div className="feed-meta">
        <span className="verb-badge">{verbName}</span>{" "}
        <span className="muted small">
          @{authorHandle} · #{decoded.seq} ·{" "}
          {new Date(entry.timestampSecs * 1000).toLocaleString()}
        </span>
      </div>
      <div className="feed-text">{decoded.contentText}</div>
      {inlineUrl && <img className="feed-media" src={inlineUrl} alt="inline media" />}
      {assetRefAddr && (
        <div className="muted small">
          Asset ref:{" "}
          <a
            href={`https://explorer.aptoslabs.com/object/${assetRefAddr}?network=mainnet`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {shortAddr(assetRefAddr)}
          </a>
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
      {canAct && (
        <div className="feed-actions">
          <button
            className="link"
            onClick={() => fire(SPARK_FN, sparkArgs(decoded.author, decoded.seq))}
            disabled={busy != null}
          >
            spark
          </button>
          <button
            className="link"
            onClick={() => fire(ECHO_FN, echoArgs(decoded.author, decoded.seq))}
            disabled={busy != null}
          >
            echo
          </button>

          {/* Press: state machine driven by isPressEnabled + hasPressed.
              - enabled === null: still loading
              - enabled === false + author: show "Enable press" affordance
              - enabled === false + non-author: hide entirely (can't press what isn't enabled)
              - enabled === true + !iPressed: live press button with count
              - enabled === true + iPressed: badge */}
          {pressEnabled === null && <span className="muted small">…</span>}
          {pressEnabled === false && isAuthor && !pressForm.open && (
            <button
              className="link"
              onClick={() => setPressForm((f) => ({ ...f, open: true }))}
              disabled={busy != null}
            >
              enable press
            </button>
          )}
          {pressEnabled === true && !iPressed && (
            <button
              className="link"
              onClick={() => fire(PRESS_FN, pressArgs(decoded.author, decoded.seq))}
              disabled={busy != null}
            >
              press ({pressCount})
            </button>
          )}
          {pressEnabled === true && iPressed && (
            <span className="muted small">pressed ✓ ({pressCount})</span>
          )}
        </div>
      )}

      {actionError && (
        <p className="error small" style={{ marginTop: 6 }}>
          {actionError}
        </p>
      )}

      {pressForm.open && isAuthor && (
        <div className="card-stat" style={{ marginTop: 8, padding: 8, background: "#0a0a0a" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <label>
              Supply cap{" "}
              <input
                className="inline-num"
                type="number"
                min="1"
                max="1000"
                value={pressForm.supplyCap}
                onChange={(e) => setPressForm((f) => ({ ...f, supplyCap: e.target.value }))}
              />
            </label>
            <label>
              Window (days)
              <input
                className="inline-num"
                type="number"
                min="1"
                max="7"
                value={pressForm.windowDays}
                onChange={(e) => setPressForm((f) => ({ ...f, windowDays: e.target.value }))}
              />
            </label>
            <button className="primary" onClick={enablePress} disabled={busy != null}>
              {busy ? "…" : "Enable"}
            </button>
            <button
              className="link"
              onClick={() => setPressForm((f) => ({ ...f, open: false }))}
            >
              cancel
            </button>
          </div>
          <small className="muted">
            One-time per mint. Cap 1-1000, window 1-7 days. Pressers earn linear-curve
            emission from your token's reaction reserve.
          </small>
        </div>
      )}
    </div>
  );
}

// ============ Compose helpers ============

// Parse "@alice#3" or "0xabc...#3" → { author: PID addr, seq: number, handle }.
// Returns null if format invalid. For 0x addrs we resolve handle via reverse
// lookup; for @ refs we resolve handle → wallet → PID addr.
async function resolveRef(input: string): Promise<Ref | null> {
  const m = input.match(/^(@?[a-z0-9_]+|0x[0-9a-f]+)#(\d+)$/i);
  if (!m) return null;
  const left = m[1];
  const seq = Number(m[2]);
  if (!Number.isFinite(seq) || seq < 0) return null;

  let pidAddr: string | null = null;
  let handle: string | null = null;

  if (left.startsWith("0x")) {
    pidAddr = left;
    handle = await handleOf(rpc, pidAddr);
  } else {
    const h = left.replace(/^@/, "").toLowerCase();
    const wallet = await handleToWallet(rpc, h);
    if (!wallet) return null;
    pidAddr = await deriveProfileAddress(rpc, wallet);
    handle = h;
  }
  if (!pidAddr || !handle) return null;

  // Verify the seq actually exists on chain — cheaper than walking history.
  const next = await nextSeq(rpc, pidAddr);
  if (seq >= next) return null;

  return { author: pidAddr, seq, handle };
}

function parseList(s: string): string[] {
  // Dedupe preserving first-occurrence order. Casing normalized at parse time
  // so "Alice" and "alice" can't both consume slots toward MENTIONS_MAX.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of s.split(/[, ]+/)) {
    const t = raw.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/// Best-effort decoding of wallet adapter / Move abort errors into a one-line
/// human-friendly message. Falls back to the raw message for unrecognized
/// errors so we never silently drop information.
function decodeWalletError(err: unknown, fn: string): string {
  const msg = (err as { message?: string })?.message ?? String(err);
  // User explicitly closed the wallet popup.
  if (/User rejected|denied|cancel/i.test(msg)) return "Cancelled in wallet.";
  // Move abort with a known DeSNet error code surface.
  const abortMatch = msg.match(/Move abort.*0x[0-9a-fA-F]+::([a-z_]+)::([A-Z_0-9]+)/);
  if (abortMatch) {
    return `${fn.split("::").slice(-1)[0]} aborted: ${abortMatch[2]}`;
  }
  // Insufficient balance — the most common gas/balance failure.
  if (/EINSUFFICIENT_BALANCE|coin store empty/i.test(msg)) {
    return "Insufficient balance for this action (gas or token).";
  }
  return msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
}

function verbLabel(v: number): string {
  switch (v) {
    case VERB.SPARK: return "Spark";
    case VERB.ECHO: return "Echo";
    case VERB.PRESS: return "Press";
    case VERB.SYNC: return "Sync";
    default: return "?";
  }
}

// shortAddr / b64encode / bytesToAddress moved to chain/desnet/format.ts
