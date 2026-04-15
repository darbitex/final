import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useState } from "react";
import { useAddress } from "../wallet/useConnect";

export function ConnectButton() {
  const { wallets, connect, disconnect, connected } = useWallet();
  const address = useAddress();
  const [open, setOpen] = useState(false);

  if (connected && address) {
    return (
      <button
        type="button"
        className="wallet-btn connected"
        onClick={() => {
          disconnect();
          setOpen(false);
        }}
        title={address}
      >
        {address.slice(0, 6)}...{address.slice(-4)}
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        className="wallet-btn"
        onClick={() => setOpen((o) => !o)}
      >
        Connect
      </button>
      {open && (
        <div className="wallet-menu">
          {wallets && wallets.length > 0 ? (
            wallets.map((w) => (
              <button
                type="button"
                key={w.name}
                className="wallet-menu-item"
                onClick={() => {
                  connect(w.name);
                  setOpen(false);
                }}
              >
                {w.icon ? <img src={w.icon} alt="" width={20} height={20} /> : null}
                <span>{w.name}</span>
              </button>
            ))
          ) : (
            <div className="wallet-menu-empty">No wallet detected — install Petra (petra.app)</div>
          )}
        </div>
      )}
    </>
  );
}
