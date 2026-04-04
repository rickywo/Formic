import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { SceneContainer } from "../components/SceneContainer";
import { TerminalWindow } from "../components/TerminalWindow";
import { Typewriter } from "../components/Typewriter";

const DURATION = 210; // 7 seconds

export const InstallScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const terminalEntry = spring({
    frame,
    fps,
    config: { damping: 15, stiffness: 80 },
  });

  const typingDone = frame > 70;
  const outputLine1 = typingDone
    ? spring({ frame: Math.max(0, frame - 75), fps, config: { damping: 12, stiffness: 100 } })
    : 0;
  const outputLine2 = typingDone
    ? spring({ frame: Math.max(0, frame - 95), fps, config: { damping: 12, stiffness: 100 } })
    : 0;
  const checkmark = typingDone
    ? spring({ frame: Math.max(0, frame - 120), fps, config: { damping: 10, stiffness: 80 } })
    : 0;

  return (
    <SceneContainer
      durationInFrames={DURATION}
      stepNumber={1}
      heading="📦 Install in seconds"
      caption="One command. Zero configuration."
    >
      <div
        style={{
          transform: `scale(${interpolate(terminalEntry, [0, 1], [0.9, 1])})`,
          opacity: terminalEntry,
        }}
      >
        <TerminalWindow title="Terminal — npm">
          <Typewriter
            text="npm install -g @rickywo/formic"
            startFrame={15}
            speed={2}
            color="#e0e0e0"
          />

          {typingDone && (
            <div style={{ marginTop: 16 }}>
              <div
                style={{
                  color: "rgba(255,255,255,0.4)",
                  opacity: outputLine1 as number,
                  transform: `translateY(${interpolate(outputLine1 as number, [0, 1], [10, 0])}px)`,
                }}
              >
                added 42 packages in 8s
              </div>
              <div
                style={{
                  color: "rgba(255,255,255,0.4)",
                  opacity: outputLine2 as number,
                  transform: `translateY(${interpolate(outputLine2 as number, [0, 1], [10, 0])}px)`,
                  marginTop: 4,
                }}
              >
                12 packages are looking for funding
              </div>
              <div
                style={{
                  marginTop: 16,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  opacity: checkmark as number,
                  transform: `scale(${checkmark})`,
                }}
              >
                <span style={{ color: "#27c93f", fontSize: 20 }}>✓</span>
                <span style={{ color: "#27c93f" }}>
                  formic@0.7.4 installed globally
                </span>
              </div>
            </div>
          )}
        </TerminalWindow>
      </div>
    </SceneContainer>
  );
};

export const INSTALL_DURATION = DURATION;
