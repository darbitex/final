import { NavLink, Outlet } from "react-router-dom";
import { PACKAGE } from "../config";
import { ConnectButton } from "./ConnectButton";
import { RpcOverrideButton } from "./RpcOverrideButton";
import { SlippageButton } from "./SlippageButton";

export function Layout() {
  const explorer = `https://explorer.aptoslabs.com/account/${PACKAGE}/modules/code/pool_factory?network=mainnet`;
  return (
    <>
      <div className="header">
        <div className="logo">
          <svg
            className="mark"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 21 Q 3 3 21 3" />
            <path d="M21 3 Q 21 11 14 11" />
          </svg>
          Darbitex
        </div>
        <div className="header-actions">
          <RpcOverrideButton />
          <SlippageButton />
          <ConnectButton />
        </div>
      </div>

      <nav className="nav">
        <NavLink to="/" end>Trade</NavLink>
        <NavLink to="/arbitrage">Arbitrage</NavLink>
        <NavLink to="/liquidity">Liquidity</NavLink>
        <NavLink to="/earn">Earn</NavLink>
        <NavLink to="/tools">Tools</NavLink>
        <NavLink to="/one">ONE</NavLink>
        <NavLink to="/about">About</NavLink>
      </nav>

      <main>
        <Outlet />
      </main>

      <div className="footer">
        <a href={explorer} target="_blank" rel="noopener noreferrer">
          Darbitex
        </a>{" "}
        · Aptos Mainnet · 1 bps LP fee{" "}
        <a
          className="social"
          href="https://x.com/Darbitex"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="X / Twitter"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
        </a>
      </div>
    </>
  );
}
