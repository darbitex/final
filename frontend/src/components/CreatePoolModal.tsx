import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useMemo, useState } from "react";
import { PACKAGE, TOKENS, type TokenConfig } from "../config";
import { useFaBalance } from "../chain/balance";
import { toRaw } from "../chain/rpc-pool";
import { Modal } from "./Modal";

// Final's pool_factory::create_canonical_pool asserts the metadata pair
// is strictly sorted by BCS bytes (`assert_sorted`). Address BCS encoding
// is 32 big-endian bytes, so comparing the 64-char lowercase hex payload
// lexicographically matches BCS ordering exactly.
function bcsAddrLt(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/^0x/i, "").padStart(64, "0").toLowerCase();
  return norm(a) < norm(b);
}

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
  const [tokenA, setTokenA] = useState<TokenConfig>(TOKENS.APT);
  const [tokenB, setTokenB] = useState<TokenConfig>(TOKENS.USDC);
  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);

  const balA = useFaBalance(tokenA.meta, tokenA.decimals);
  const balB = useFaBalance(tokenB.meta, tokenB.decimals);

  const sameToken = tokenA.meta === tokenB.meta;

  async function submit() {
    if (!connected) {
      setStatus({ text: "Connect wallet first", error: true });
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
      // Sort pair to match the on-chain `assert_sorted` invariant. If
      // the user picked them in the "wrong" order, we silently swap the
      // tokens and their amounts together so ratios stay consistent.
      let mA = tokenA;
      let mB = tokenB;
      let amtARaw = toRaw(numA, tokenA.decimals);
      let amtBRaw = toRaw(numB, tokenB.decimals);
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

  return (
    <Modal open={open} onClose={onClose} title="Create canonical pool">
      <div className="modal-note">
        Permissionless pool creation — any wallet can seed a new canonical pair. The factory
        rejects duplicates and unsorted metadata automatically; the frontend sorts for you.
      </div>

      <label>Token A</label>
      <select
        value={tokenA.symbol}
        onChange={(e) => {
          const t = tokenList.find((x) => x.symbol === e.target.value);
          if (t) setTokenA(t);
        }}
      >
        {tokenList.map((t) => (
          <option key={t.symbol} value={t.symbol}>
            {t.symbol}
          </option>
        ))}
      </select>

      <label>Seed amount A</label>
      <input
        type="number"
        value={amountA}
        onChange={(e) => setAmountA(e.target.value)}
        min="0"
        placeholder="0.0"
      />
      {connected && (
        <button
          type="button"
          className="bal-link bal-link-modal"
          onClick={() => balA.raw > 0n && setAmountA(String(balA.formatted))}
          disabled={balA.raw === 0n}
        >
          Balance: {balA.loading ? "…" : balA.formatted.toFixed(6)} {tokenA.symbol}
        </button>
      )}

      <label>Token B</label>
      <select
        value={tokenB.symbol}
        onChange={(e) => {
          const t = tokenList.find((x) => x.symbol === e.target.value);
          if (t) setTokenB(t);
        }}
      >
        {tokenList.map((t) => (
          <option key={t.symbol} value={t.symbol}>
            {t.symbol}
          </option>
        ))}
      </select>

      <label>Seed amount B</label>
      <input
        type="number"
        value={amountB}
        onChange={(e) => setAmountB(e.target.value)}
        min="0"
        placeholder="0.0"
      />
      {connected && (
        <button
          type="button"
          className="bal-link bal-link-modal"
          onClick={() => balB.raw > 0n && setAmountB(String(balB.formatted))}
          disabled={balB.raw === 0n}
        >
          Balance: {balB.loading ? "…" : balB.formatted.toFixed(6)} {tokenB.symbol}
        </button>
      )}

      {status && (
        <div className={`modal-status ${status.error ? "error" : ""}`}>{status.text}</div>
      )}

      <button
        type="button"
        className="btn btn-primary"
        onClick={submit}
        disabled={busy || sameToken}
      >
        {busy ? "Submitting…" : "Create pool"}
      </button>
    </Modal>
  );
}
