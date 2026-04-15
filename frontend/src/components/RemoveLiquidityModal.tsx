import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useState } from "react";
import { PACKAGE } from "../config";
import { Modal } from "./Modal";

export type RemoveTarget = {
  poolAddr: string;
  symbolA: string;
  symbolB: string;
};

export function RemoveLiquidityModal({
  target,
  onClose,
  onDone,
}: {
  target: RemoveTarget | null;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { signAndSubmitTransaction, connected } = useWallet();
  const [positionAddr, setPositionAddr] = useState("");
  const [minA, setMinA] = useState("0");
  const [minB, setMinB] = useState("0");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);

  if (!target) return null;

  async function submit() {
    if (!connected) {
      setStatus({ text: "Connect wallet first", error: true });
      return;
    }
    if (!/^0x[0-9a-f]+$/i.test(positionAddr.trim())) {
      setStatus({ text: "Paste a valid LpPosition object address", error: true });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const deadline = Math.floor(Date.now() / 1000) + 300;
      const result = await signAndSubmitTransaction({
        data: {
          function: `${PACKAGE}::pool::remove_liquidity_entry`,
          typeArguments: [],
          functionArguments: [
            positionAddr.trim(),
            (BigInt(minA || "0")).toString(),
            (BigInt(minB || "0")).toString(),
            deadline.toString(),
          ],
        },
      });
      setStatus({
        text: `Submitted: ${result.hash.slice(0, 12)}…`,
        error: false,
      });
      onDone?.();
    } catch (e) {
      setStatus({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={!!target}
      onClose={onClose}
      title={`Remove liquidity — ${target.symbolA}/${target.symbolB}`}
    >
      <div className="modal-note">
        Burns an LpPosition object and returns proportional reserves plus any accumulated
        fees. Paste the position object address — find it on the Aptos Explorer under your
        wallet's digital assets, or via <code>getAccountOwnedObjects</code>.
      </div>

      <label>LpPosition object address</label>
      <input
        type="text"
        value={positionAddr}
        onChange={(e) => setPositionAddr(e.target.value)}
        placeholder="0x…"
        spellCheck={false}
      />

      <label>Min {target.symbolA} out (raw units — 0 = no floor)</label>
      <input
        type="text"
        value={minA}
        onChange={(e) => setMinA(e.target.value)}
        placeholder="0"
      />

      <label>Min {target.symbolB} out (raw units — 0 = no floor)</label>
      <input
        type="text"
        value={minB}
        onChange={(e) => setMinB(e.target.value)}
        placeholder="0"
      />

      {status && (
        <div className={`modal-status ${status.error ? "error" : ""}`}>{status.text}</div>
      )}

      <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
        {busy ? "Submitting…" : "Remove liquidity"}
      </button>
    </Modal>
  );
}
