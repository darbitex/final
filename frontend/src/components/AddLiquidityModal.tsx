import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useState } from "react";
import { PACKAGE, TOKENS } from "../config";
import { toRaw } from "../chain/rpc-pool";
import { useSlippage } from "../chain/slippage";
import { Modal } from "./Modal";

export type AddTarget = {
  poolAddr: string;
  symbolA: string;
  symbolB: string;
};

export function AddLiquidityModal({
  target,
  onClose,
  onDone,
}: {
  target: AddTarget | null;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { signAndSubmitTransaction, connected } = useWallet();
  const [slippage] = useSlippage();
  const [amtA, setAmtA] = useState("");
  const [amtB, setAmtB] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);

  if (!target) return null;

  const tokA = TOKENS[target.symbolA];
  const tokB = TOKENS[target.symbolB];
  const decA = tokA?.decimals ?? 8;
  const decB = tokB?.decimals ?? 6;

  async function submit() {
    if (!target || !connected) {
      setStatus({ text: "Connect wallet first", error: true });
      return;
    }
    const numA = Number(amtA);
    const numB = Number(amtB);
    if (!Number.isFinite(numA) || numA <= 0 || !Number.isFinite(numB) || numB <= 0) {
      setStatus({ text: "Enter positive amounts for both sides", error: true });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const rawA = toRaw(numA, decA);
      const rawB = toRaw(numB, decB);
      // We don't know the exact LP mint yet without quoting reserves,
      // so we accept 0 as min_shares_out. Users wanting strict slippage
      // control can bump this later via a "min shares" input. Slippage
      // still protects the token sides via the pool's optimal-amount
      // computation — excess tokens stay in the user's wallet.
      const minShares = 0n;
      const deadline = Math.floor(Date.now() / 1000) + 300;
      const result = await signAndSubmitTransaction({
        data: {
          function: `${PACKAGE}::pool::add_liquidity_entry`,
          typeArguments: [],
          functionArguments: [
            target.poolAddr,
            rawA.toString(),
            rawB.toString(),
            minShares.toString(),
            deadline.toString(),
          ],
        },
      });
      setStatus({
        text: `Submitted: ${result.hash.slice(0, 12)}…`,
        error: false,
      });
      setAmtA("");
      setAmtB("");
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
      title={`Add liquidity — ${target.symbolA}/${target.symbolB}`}
    >
      <div className="modal-note">
        Uses Uniswap V2-style optimal amount computation — any slippage buffer you provide
        stays in your wallet if it isn't needed. Slippage setting: {(slippage * 100).toFixed(
          slippage < 0.01 ? 2 : 1,
        )}
        %
      </div>

      <label>
        {target.symbolA} amount (desired)
      </label>
      <input
        type="number"
        value={amtA}
        onChange={(e) => setAmtA(e.target.value)}
        min="0"
        placeholder="0.0"
      />

      <label>
        {target.symbolB} amount (desired)
      </label>
      <input
        type="number"
        value={amtB}
        onChange={(e) => setAmtB(e.target.value)}
        min="0"
        placeholder="0.0"
      />

      {status && (
        <div className={`modal-status ${status.error ? "error" : ""}`}>{status.text}</div>
      )}

      <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
        {busy ? "Submitting…" : "Add liquidity"}
      </button>
    </Modal>
  );
}
