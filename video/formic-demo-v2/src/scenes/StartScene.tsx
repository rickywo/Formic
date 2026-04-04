import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { SceneContainer } from "../components/SceneContainer";
import { TerminalWindow } from "../components/TerminalWindow";
import { Typewriter } from "../components/Typewriter";

const DURATION = 210; // 7 seconds

export const StartScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const terminalEntry = spring({
    frame,
    fps,
    config: { damping: 15, stiffness: 80 },
  });

  const typingDone = frame > 55;
  const bannerShow = typingDone
    ? spring({ frame: Math.max(0, frame - 60), fps, config: { damping: 12, stiffness: 100 } })
    : 0;
  const statusShow = typingDone
    ? spring({ frame: Math.max(0, frame - 90), fps, config: { damping: 12, stiffness: 100 } })
    : 0;
  const subsShow = typingDone
    ? spring({ frame: Math.max(0, frame - 110), fps, config: { damping: 12, stiffness: 100 } })
    : 0;

  return (
    <SceneContainer
      durationInFrames={DURATION}
      stepNumber={2}
      heading="🚀 Launch the server"
      caption="Your AI dev team is now online."
    >
      <div
        style={{
          transform: `scale(${interpolate(terminalEntry, [0, 1], [0.9, 1])})`,
          opacity: terminalEntry,
        }}
      >
        <TerminalWindow title="Terminal — formic">
          <Typewriter
            text="PORT=8000 formic start"
            startFrame={10}
            speed={2}
            color="#e0e0e0"
          />

          {typingDone && (
            <div style={{ marginTop: 16 }}>
              <div
                style={{
                  color: "#8b5cf6",
                  opacity: bannerShow as number,
                  transform: `translateY(${interpolate(bannerShow as number, [0, 1], [10, 0])}px)`,
                  fontWeight: 700,
                  fontSize: 18,
                  letterSpacing: 4,
                }}
              >
                🐜 F O R M I C{" "}
                <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 13, fontWeight: 400 }}>
                  v0.7.4
                </span>
              </div>

              <div
                style={{
                  marginTop: 16,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  opacity: statusShow as number,
                  transform: `translateY(${interpolate(statusShow as number, [0, 1], [10, 0])}px)`,
                }}
              >
                <span style={{ color: "#27c93f", fontSize: 18 }}>✓</span>
                <span style={{ color: "#27c93f" }}>
                  Server running on http://localhost:8000
                </span>
              </div>

              <div
                style={{
                  marginTop: 8,
                  opacity: subsShow as number,
                  transform: `translateY(${interpolate(subsShow as number, [0, 1], [10, 0])}px)`,
                  color: "rgba(255,255,255,0.4)",
                  fontSize: 14,
                }}
              >
                ✓ WebSocket connected · ✓ Queue processor ready · ✓ Watchdog active
              </div>
            </div>
          )}
        </TerminalWindow>
      </div>
    </SceneContainer>
  );
};

export const START_DURATION = DURATION;
