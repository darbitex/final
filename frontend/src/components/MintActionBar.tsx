// MintActionBar — shared icon-only verb action row for any mint render.
//
// Used by both Feed.tsx (own-profile FeedRow) and Feeds.tsx (aggregated
// FeedAggregatedRow). Voice/Remix availability differs by context — passed
// in as `voiceRemixHandler` (null = render disabled with tooltip).

import { useEffect, useState } from "react";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { ECHO_FN, SPARK_FN, echoArgs, sparkArgs } from "../chain/desnet/pulse";
import { ENABLE_PRESS_FN, PRESS_FN, enablePressArgs, hasPressed, isPressEnabled, pressArgs, pressedCount } from "../chain/desnet/press";
import { marketExists } from "../chain/desnet/opinion";
import { aptosAddrEq } from "../chain/desnet/format";
import { createRpcPool } from "../chain/rpc-pool";
import { OpinionInlineActions } from "./OpinionInlineActions";
import { EchoIcon, OpinionIcon, PressIcon, RemixIcon, ShareIcon, SparkIcon, VoiceIcon } from "./VerbIcons";
import type { MoveArg, MoveFn } from "../chain/desnet/tx";

const rpc = createRpcPool("mint-action-bar");

export type VoiceRemixContext = {
  /** Called when Voice/Remix icon is clicked. mode = which one. */
  onClick: (mode: "voice" | "remix") => void;
  /** Whether the action is currently enabled (e.g. user has a handle). */
  enabled: boolean;
  /** Tooltip when disabled — explains how to enable. */
  disabledTooltip?: string;
};

export function MintActionBar({
  authorPid,
  seq,
  authorHandle,
  myPid,
  voiceRemix,
}: {
  authorPid: string;
  seq: number;
  authorHandle: string;
  myPid: string | null;
  /** Voice/Remix context. null → icons hidden entirely. */
  voiceRemix: VoiceRemixContext | null;
}) {
  const { signAndSubmitTransaction } = useWallet();
  const canAct = !!myPid;
  const isAuthor = !!myPid && aptosAddrEq(myPid, authorPid);

  const [busy, setBusy] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);

  // Press state
  const [pressEnabled, setPressEnabled] = useState<boolean | null>(null);
  const [pressCount, setPressCount] = useState<number>(0);
  const [iPressed, setIPressed] = useState<boolean>(false);
  const [pressForm, setPressForm] = useState<{ open: boolean; supplyCap: string; windowDays: string }>({
    open: false,
    supplyCap: "100",
    windowDays: "7",
  });

  // Opinion state
  const [opinionMarket, setOpinionMarket] = useState<boolean | null>(null);
  const [opinionOpen, setOpinionOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    marketExists(rpc, authorPid, seq).then((ok) => {
      if (!cancelled) setOpinionMarket(ok);
    });
    return () => { cancelled = true; };
  }, [authorPid, seq]);

  useEffect(() => {
    let cancelled = false;
    isPressEnabled(rpc, authorPid, seq).then(async (en) => {
      if (cancelled) return;
      setPressEnabled(en);
      if (en) {
        const [count, mine] = await Promise.all([
          pressedCount(rpc, authorPid, seq),
          myPid ? hasPressed(rpc, myPid, authorPid, seq) : Promise.resolve(false),
        ]);
        if (cancelled) return;
        setPressCount(count);
        setIPressed(mine);
      }
    });
    return () => { cancelled = true; };
  }, [authorPid, seq, myPid, refreshTick]);

  async function fire(fn: MoveFn, args: MoveArg[]) {
    setBusy(fn);
    setActionError(null);
    try {
      await signAndSubmitTransaction({
        data: { function: fn, typeArguments: [], functionArguments: args },
      });
      setRefreshTick((t) => t + 1);
    } catch (e) {
      setActionError(decodeWalletErr(e, fn));
    } finally {
      setBusy(null);
    }
  }

  async function enablePress() {
    const cap = Math.max(1, Math.min(1000, Number(pressForm.supplyCap) || 0));
    const days = Math.max(1, Math.min(7, Number(pressForm.windowDays) || 0));
    setBusy(ENABLE_PRESS_FN);
    setActionError(null);
    try {
      await signAndSubmitTransaction({
        data: { function: ENABLE_PRESS_FN, typeArguments: [], functionArguments: enablePressArgs(seq, cap, days) },
      });
      setPressForm((f) => ({ ...f, open: false }));
      setRefreshTick((t) => t + 1);
    } catch (e) {
      setActionError(decodeWalletErr(e, ENABLE_PRESS_FN));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="feed-actions" style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button
          className="link verb-btn"
          onClick={() => canAct && fire(SPARK_FN, sparkArgs(authorPid, seq))}
          disabled={!canAct || busy != null}
          title={canAct ? "Spark (like)" : "Connect wallet with handle to spark"}
          aria-label="spark"
          style={iconBtnStyle}
        >
          <SparkIcon />
        </button>

        {voiceRemix && (
          <button
            className="link verb-btn"
            onClick={() => voiceRemix.enabled && voiceRemix.onClick("voice")}
            disabled={!voiceRemix.enabled || busy != null}
            title={voiceRemix.enabled ? "Voice (reply)" : voiceRemix.disabledTooltip ?? "Voice disabled"}
            aria-label="voice"
            style={iconBtnStyle}
          >
            <VoiceIcon />
          </button>
        )}

        <button
          className="link verb-btn"
          onClick={() => canAct && fire(ECHO_FN, echoArgs(authorPid, seq))}
          disabled={!canAct || busy != null}
          title={canAct ? "Echo (repost)" : "Connect wallet with handle to echo"}
          aria-label="echo"
          style={iconBtnStyle}
        >
          <EchoIcon />
        </button>

        {voiceRemix && (
          <button
            className="link verb-btn"
            onClick={() => voiceRemix.enabled && voiceRemix.onClick("remix")}
            disabled={!voiceRemix.enabled || busy != null}
            title={voiceRemix.enabled ? "Remix (quote)" : voiceRemix.disabledTooltip ?? "Remix disabled"}
            aria-label="remix"
            style={iconBtnStyle}
          >
            <RemixIcon />
          </button>
        )}

        {pressEnabled === null && <span className="muted small" title="loading">…</span>}
        {pressEnabled === false && isAuthor && !pressForm.open && (
          <button
            className="link verb-btn"
            onClick={() => setPressForm((f) => ({ ...f, open: true }))}
            disabled={busy != null}
            title="Enable press emission for this mint (author only)"
            aria-label="enable press"
            style={{ ...iconBtnStyle, opacity: 0.7 }}
          >
            <PressIcon /> + enable
          </button>
        )}
        {pressEnabled === false && !isAuthor && (
          <span
            className="muted small"
            title="Author hasn't enabled press emission yet"
            style={{ ...iconBtnStyle, opacity: 0.4 }}
          >
            <PressIcon />
          </span>
        )}
        {pressEnabled === true && !iPressed && (
          <button
            className="link verb-btn"
            onClick={() => canAct && fire(PRESS_FN, pressArgs(authorPid, seq))}
            disabled={!canAct || busy != null}
            title={canAct ? `Press (collect, ${pressCount} pressed)` : "Connect wallet with handle to press"}
            aria-label="press"
            style={iconBtnStyle}
          >
            <PressIcon /> {pressCount > 0 ? pressCount : ""}
          </button>
        )}
        {pressEnabled === true && iPressed && (
          <span className="muted small" title={`You pressed this. ${pressCount} total.`} style={iconBtnStyle}>
            <PressIcon /> {pressCount} ✓
          </span>
        )}

        {opinionMarket === true && (
          <button
            className="link verb-btn"
            onClick={() => setOpinionOpen((o) => !o)}
            title={opinionOpen ? "Hide opinion market" : "Open opinion market (YAY/NAY)"}
            aria-label="opinion"
            aria-expanded={opinionOpen}
            style={{
              ...iconBtnStyle,
              color: opinionOpen ? "#fff" : "#0EF",
              background: opinionOpen ? "#1a4480" : "transparent",
              padding: opinionOpen ? "2px 6px" : 0,
              borderRadius: 4,
            }}
          >
            <OpinionIcon />
          </button>
        )}

        <button
          className="link verb-btn"
          onClick={async () => {
            const permalink = `/desnet/p/${authorHandle}/m/${seq}`;
            const fullUrl =
              typeof window !== "undefined" ? window.location.origin + permalink : permalink;
            if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
              try {
                await navigator.share({ title: `@${authorHandle} on DeSNet`, url: fullUrl });
                return;
              } catch {
                // user cancelled or share failed — fall through to twitter intent
              }
            }
            const tweet = `https://twitter.com/intent/tweet?url=${encodeURIComponent(fullUrl)}`;
            if (typeof window !== "undefined") window.open(tweet, "_blank", "noopener,noreferrer");
          }}
          title="Share permalink"
          aria-label="share"
          style={iconBtnStyle}
        >
          <ShareIcon />
        </button>
      </div>

      {actionError && <p className="error small" style={{ marginTop: 6 }}>{actionError}</p>}

      {opinionMarket === true && opinionOpen && (
        <OpinionInlineActions authorPid={authorPid} seq={seq} authorHandle={authorHandle} />
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
            <button className="link" onClick={() => setPressForm((f) => ({ ...f, open: false }))}>
              cancel
            </button>
          </div>
          <small className="muted">
            One-time per mint. Cap 1-1000, window 1-7 days. Pressers earn linear-curve emission from your token's
            reaction reserve.
          </small>
        </div>
      )}
    </>
  );
}

const iconBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
};

function decodeWalletErr(err: unknown, fn: string): string {
  const msg = (err as { message?: string })?.message ?? String(err);
  if (/User rejected|denied|cancel/i.test(msg)) return "Cancelled in wallet.";
  const abortMatch = msg.match(/Move abort.*0x[0-9a-fA-F]+::([a-z_]+)::([A-Z_0-9]+)/);
  if (abortMatch) return `${fn.split("::").slice(-1)[0]} aborted: ${abortMatch[2]}`;
  if (/EINSUFFICIENT_BALANCE|coin store empty/i.test(msg)) return "Insufficient balance for this action.";
  return msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
}
