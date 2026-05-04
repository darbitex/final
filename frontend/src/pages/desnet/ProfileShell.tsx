import { NavLink, Outlet, useParams } from "react-router-dom";
import { validateHandle } from "../../chain/desnet/profile";

export function ProfileShell() {
  const { handle } = useParams<{ handle: string }>();
  const safe = (handle ?? "").toLowerCase();
  // Defense in depth: React JSX auto-escapes text children, but the same
  // value is interpolated into NavLink `to` paths where react-router does
  // not URL-encode. A handle outside the validator's grammar (a-z, 0-9,
  // underscore, length 1-64) would never resolve on chain anyway, so we
  // hard-fail the route render rather than letting weird strings through.
  const handleErr = validateHandle(safe);
  if (handleErr) {
    return (
      <div className="container">
        <div className="card">
          <h2>Invalid handle</h2>
          <p className="muted">
            <code>@{safe}</code> isn't a valid DeSNet handle ({handleErr}). Handles
            are lowercase a-z, digits, underscore, 1-64 bytes, must start with
            a letter.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="container">
      <div className="subnav">
        <NavLink end to={`/desnet/p/${safe}`}>Profile</NavLink>
        <NavLink to={`/desnet/p/${safe}/post`}>Post</NavLink>
        <NavLink to={`/desnet/p/${safe}/about`}>About</NavLink>
      </div>
      <Outlet />
    </div>
  );
}
