import { useLive } from "../store/hooks.js";
import { banners } from "../store/status.js";
import type { Banner } from "../store/status.js";
import { localResumeTime } from "./format.js";

function BannerText({ banner }: { banner: Banner }) {
  switch (banner.kind) {
    case "stopped":
      return (
        <>
          <strong>Stopped.</strong> mastermind stopped (terminal closed or Ctrl+C). Run{" "}
          <code>mastermind .</code> to continue.
        </>
      );
    case "unauthorized":
      return (
        <>
          <strong>No access.</strong> This page can&apos;t reach mastermind without its link. Open
          the link printed in the terminal.
        </>
      );
    case "sign-in":
      return (
        <>
          <strong>Sign-in needed:</strong> finish it in the terminal running mastermind.
        </>
      );
    case "usage-limit":
      return (
        <>
          <strong>Usage limit reached:</strong> work resumes at {localResumeTime(banner.resumeAt)}.
        </>
      );
  }
}

export function Banners() {
  const connection = useLive((state) => state.connection);
  const scheduler = useLive((state) => state.scheduler);
  const shown = banners(connection, scheduler);
  if (shown.length === 0) return null;

  return (
    <div className="banners">
      {shown.map((banner) => (
        <p key={banner.kind} role="alert" className="banner">
          <BannerText banner={banner} />
        </p>
      ))}
    </div>
  );
}
