import { ImageResponse } from "next/og";

/**
 * The social card, printed at build time: ink paper, the claim,
 * the wire's clock. Only the yard's own words and numbers.
 */
export const alt = "switchyard: a Go message broker that never lies";
export const size = { width: 1200, height: 628 };
export const contentType = "image/png";
// static export wants the route pinned, so the build prints it once.
export const dynamic = "force-static";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#16161a",
          color: "#f1efeb",
          padding: 72,
        }}
      >
        {/* plate row */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            borderBottom: "1px solid rgba(241,239,235,0.25)",
            paddingBottom: 24,
            fontSize: 26,
            letterSpacing: 8,
            color: "rgba(241,239,235,0.7)",
            textTransform: "uppercase",
          }}
        >
          <div style={{ display: "flex" }}>SWITCHYARD · A GO MESSAGE BROKER</div>
          <div style={{ display: "flex", color: "#ff4708", fontWeight: 700 }}>
            V1.0.0
          </div>
        </div>

        {/* the claim */}
        <div
          style={{
            display: "flex",
            fontSize: 108,
            fontWeight: 700,
            letterSpacing: -3,
            lineHeight: 1.08,
          }}
        >
          The yard never
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 108,
            fontWeight: 700,
            letterSpacing: -3,
            lineHeight: 1.08,
            color: "#ff4708",
          }}
        >
          lies.
        </div>

        {/* the wire's clock */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            borderTop: "1px solid rgba(241,239,235,0.25)",
            paddingTop: 24,
            fontSize: 26,
            letterSpacing: 2,
            color: "rgba(241,239,235,0.8)",
          }}
        >
          <div style={{ display: "flex" }}>17.4k probes/s · p95 ~ 0.52 ms</div>
          <div style={{ display: "flex" }}>1.15M deliveries/s · receipt per row</div>
        </div>
      </div>
    ),
    { ...size },
  );
}
