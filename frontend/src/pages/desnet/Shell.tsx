import { NavLink, Outlet } from "react-router-dom";

export function DesnetShell() {
  return (
    <div className="container">
      <h1 className="page-title">DeSNet</h1>
      <p className="page-sub">
        Decentralized social network on Aptos. Every profile is a transferable
        Object NFT, every profile spawns its own fungible token, every social
        action is an on-chain primitive. Live at <code>@desnet</code>.
      </p>
      <div className="subnav">
        <NavLink end to="/desnet/register">Register</NavLink>
        <NavLink to="/desnet/swap">Swap</NavLink>
        <NavLink to="/desnet/liquidity">Liquidity</NavLink>
        <NavLink to="/desnet/portfolio">Portfolio</NavLink>
      </div>
      <Outlet />
    </div>
  );
}
