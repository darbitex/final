import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useEffect, useMemo, useState } from "react";
import { PACKAGE, TOKENS, type TokenConfig } from "../config";
import { fetchFaMetadata, useFaBalance } from "../chain/balance";
import { toRaw } from "../chain/rpc-pool";
import { Modal } from "./Modal";
import { TokenIcon } from "./TokenIcon";

// Final's pool_factory::create_canonical_pool asserts the metadata pair
// is strictly sorted by BCS bytes (`assert_sorted`). Address BCS encoding
// is 32 big-endian bytes, so comparing the 64-char lowercase hex payload
// lexicographically matches BCS ordering exactly.
function bcsAddrLt(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/^0x/i, "").padStart(64, "0").toLowerCase();
  return norm(a) < norm(b);
}

const CUSTOM = "__custom";

type SideState = {
  symbol: string; // either a TOKENS key or CUSTOM
  customAddr: string;
  resolved: TokenConfig | null; // what actually gets submitted
  resolving: boolean;
  error: string | null;
};

const initialSide = (fallback: TokenConfig): SideState => ({
  symbol: fallback.symbol,
  customAddr: "",
  resolved: fallback,
  resolving: false,
  error: null,
});

export function CreatePoolModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: () => void;
}) {
  const { signAndSubmitTransaction, connected } = useWallet();
  const tokenList = useMemo(() => Object.values(TOKENS), []);

  const [sideA, setSideA] = useState<SideState>(() => initialSide(TOKENS.APT));
  const [sideB, setSideB] = useState<SideState>(() => initialSide(TOKENS.USDC));
  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);

  const tokA = sideA.resolved;
  const tokB = sideB.resolved;

  const balA = useFaBalance(tokA?.meta ?? null, tokA?.decimals ?? 0);
  const balB = useFaBalance(tokB?.meta ?? null, tokB?.decimals ?? 0);

  const sameToken =
    !!tokA && !!tokB && tokA.meta.toLowerCase() === tokB.meta.toLowerCase();

  // Resolve custom FA metadata whenever the user pastes a new address.
  // Debounced lightly via React's natural rerender cycle (no explicit
  // debounce needed — the input is local state and this effect fires
  // only on change).
  function resolveCustom(
    addr: string,
    setSide: React.Dispatch<React.SetStateAction<SideState>>,
  ) {
    if (!/^0x[0-9a-f]+$/i.test(addr.trim())) {
      setSide((s) => ({ ...s, resolved: null, error: "Enter a valid 0x… FA metadata address", resolving: false }));
      return;
    }
    setSide((s) => ({ ...s, resolving: true, error: null }));
    fetchFaMetadata(addr.trim()).then((r) => {
      if (!r) {
        setSide((s) => ({ ...s, resolving: false, error: "Not a Fungible Asset Metadata object", resolved: null }));
        return;
      }
      setSide((s) => ({
        ...s,
        resolving: false,
        error: null,
        resolved: { meta: r.meta, symbol: r.symbol, decimals: r.decimals, icon: r.iconUri },
      }));
    });
  }

  useEffect(() => {
    if (sideA.symbol === CUSTOM) resolveCustom(sideA.customAddr, setSideA);
  }, [sideA.symbol, sideA.customAddr]);

  useEffect(() => {
    if (sideB.symbol === CUSTOM) resolveCustom(sideB.customAddr, setSideB);
  }, [sideB.symbol, sideB.customAddr]);

  function pickSide(
    setSide: React.Dispatch<React.SetStateAction<SideState>>,
    value: string,
  ) {
    if (value === CUSTOM) {
      setSide((s) => ({ ...s, symbol: CUSTOM, resolved: null, error: null }));
    } else {
      const t = tokenList.find((x) => x.symbol === value);
      if (t) {
        setSide({ symbol: value, customAddr: "", resolved: t, resolving: false, error: null });
      }
    }
  }

  async function submit() {
    if (!connected) {
      setStatus({ text: "Connect wallet first", error: true });
      return;
    }
    if (!tokA || !tokB) {
      setStatus({ text: "Both tokens must be resolved first", error: true });
      return;
    }
    if (sameToken) {
      setStatus({ text: "Tokens must differ", error: true });
      return;
    }
    const numA = Number(amountA);
    const numB = Number(amountB);
    if (!Number.isFinite(numA) || numA <= 0 || !Number.isFinite(numB) || numB <= 0) {
      setStatus({ text: "Enter positive seed amounts for both sides", error: true });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      let mA = tokA;
      let mB = tokB;
      let amtARaw = toRaw(numA, tokA.decimals);
      let amtBRaw = toRaw(numB, tokB.decimals);
      if (!bcsAddrLt(mA.meta, mB.meta)) {
        [mA, mB] = [mB, mA];
        [amtARaw, amtBRaw] = [amtBRaw, amtARaw];
      }

      const result = await signAndSubmitTransaction({
        data: {
          function: `${PACKAGE}::pool_factory::create_canonical_pool`,
          typeArguments: [],
          functionArguments: [mA.meta, mB.meta, amtARaw.toString(), amtBRaw.toString()],
        },
      });
      setStatus({
        text: `Submitted: ${result.hash.slice(0, 12)}…`,
        error: false,
      });
      setAmountA("");
      setAmountB("");
      balA.refresh();
      balB.refresh();
      onCreated?.();
    } catch (e) {
      setStatus({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  }

  const renderSide = (
    side: SideState,
    setSide: React.Dispatch<React.SetStateAction<SideState>>,
    labelPrefix: string,
    amount: string,
    setAmount: (v: string) => void,
    bal: ReturnType<typeof useFaBalance>,
  ) => (
    <>
      <label>Token {labelPrefix}</label>
      <span className="token-select-with-icon">
        <TokenIcon
          token={
            side.resolved ?? (TOKENS[side.symbol] ?? { symbol: side.symbol })
          }
          size={18}
        />
        <select value={side.symbol} onChange={(e) => pickSide(setSide, e.target.value)}>
          {tokenList.map((t) => (
            <option key={t.symbol} value={t.symbol}>
              {t.symbol}
            </option>
          ))}
          <option value={CUSTOM}>Other — paste FA address…</option>
        </select>
      </span>

      {side.symbol === CUSTOM && (
        <>
          <label>Custom FA metadata address</label>
          <input
            type="text"
            value={side.customAddr}
            onChange={(e) =>
              setSide((s) => ({ ...s, customAddr: e.target.value }))
            }
            placeholder="0x…"
            spellCheck={false}
          />
          {side.resolving && <div className="modal-note">Resolving metadata…</div>}
          {side.resolved && !side.resolving && (
            <div className="modal-note">
              Resolved: <strong>{side.resolved.symbol}</strong> ·{" "}
              {side.resolved.decimals} decimals
            </div>
          )}
          {side.error && <div className="modal-status error">{side.error}</div>}
        </>
      )}

      <label>
        Seed amount {labelPrefix}
        {side.resolved ? ` (${side.resolved.symbol})` : ""}
      </label>
      <input
        type="number"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        min="0"
        placeholder="0.0"
        disabled={!side.resolved}
      />
      {connected && side.resolved && (
        <button
          type="button"
          className="bal-link bal-link-modal"
          onClick={() => bal.raw > 0n && setAmount(String(bal.formatted))}
          disabled={bal.raw === 0n}
        >
          Balance: {bal.loading ? "…" : bal.formatted.toFixed(6)} {side.resolved.symbol}
        </button>
      )}
    </>
  );

  return (
    <Modal open={open} onClose={onClose} title="Create canonical pool">
      <div className="modal-note">
        Permissionless — any wallet can seed any FA pair. Pick from the whitelist or paste a
        custom FA metadata address; the factory rejects duplicates and unsorted metadata,
        and the frontend sorts for you.
      </div>

      {renderSide(sideA, setSideA, "A", amountA, setAmountA, balA)}
      {renderSide(sideB, setSideB, "B", amountB, setAmountB, balB)}

      {status && (
        <div className={`modal-status ${status.error ? "error" : ""}`}>{status.text}</div>
      )}

      <button
        type="button"
        className="btn btn-primary"
        onClick={submit}
        disabled={busy || sameToken || !tokA || !tokB}
      >
        {busy ? "Submitting…" : "Create pool"}
      </button>
    </Modal>
  );
}
