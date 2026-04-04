import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate, Img, staticFile } from "remotion";
import { SceneContainer } from "../components/SceneContainer";

const DURATION = 180; // 6 seconds

export const WorkspaceScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const browserEntry = spring({
    frame,
    fps,
    config: { damping: 12, stiffness: 80 },
  });

  const inputShow = spring({
    frame: Math.max(0, frame - 25),
    fps,
    config: { damping: 12, stiffness: 100 },
  });

  const successShow = spring({
    frame: Math.max(0, frame - 80),
    fps,
    config: { damping: 10, stiffness: 80 },
  });

  return (
    <SceneContainer
      durationInFrames={DURATION}
      stepNumber={3}
      heading="📁 Connect your project"
      caption="Formic understands your codebase structure."
    >
      <div
        style={{
          width: 900,
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: "0 25px 60px rgba(0,0,0,0.5)",
          border: "1px solid rgba(255,255,255,0.08)",
          opacity: browserEntry,
          transform: `scale(${interpolate(browserEntry, [0, 1], [0.9, 1])})`,
        }}
      >
        {/* Browser chrome */}
        <div
          style={{
            height: 44,
            background: "#2d2d3a",
            display: "flex",
            alignItems: "center",
            padding: "0 16px",
            gap: 8,
          }}
        >
          <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#ff5f57" }} />
          <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#ffbd2e" }} />
          <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#28c840" }} />
          <div
            style={{
              flex: 1,
              margin: "0 60px",
              height: 28,
              borderRadius: 6,
              background: "rgba(255,255,255,0.06)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "rgba(255,255,255,0.4)",
              fontSize: 13,
            }}
          >
            localhost:8000
          </div>
        </div>

        {/* Content */}
        <div style={{ background: "#0d0d1a", padding: "40px 48px" }}>
          {/* Header */}
          <div
            style={{
              fontSize: 24,
              fontWeight: 700,
              color: "#fff",
              marginBottom: 32,
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <Img src={staticFile("formic.png")} style={{ width: 28, height: 28 }} /> Formic — Workspace Settings
          </div>

          {/* Input field */}
          <div
            style={{
              opacity: inputShow,
              transform: `translateY(${interpolate(inputShow, [0, 1], [15, 0])}px)`,
            }}
          >
            <div
              style={{
                fontSize: 13,
                color: "rgba(255,255,255,0.5)",
                marginBottom: 8,
                fontWeight: 500,
                textTransform: "uppercase",
                letterSpacing: 1,
              }}
            >
              Workspace Path
            </div>
            <div
              style={{
                display: "flex",
                gap: 12,
              }}
            >
              <div
                style={{
                  flex: 1,
                  height: 48,
                  borderRadius: 8,
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  display: "flex",
                  alignItems: "center",
                  padding: "0 16px",
                  color: "#e0e0e0",
                  fontFamily: "monospace",
                  fontSize: 15,
                }}
              >
                /Users/ricky/my-awesome-project
              </div>
              <div
                style={{
                  height: 48,
                  padding: "0 24px",
                  borderRadius: 8,
                  background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
                  color: "#fff",
                  fontWeight: 600,
                  fontSize: 15,
                  display: "flex",
                  alignItems: "center",
                }}
              >
                Connect
              </div>
            </div>
          </div>

          {/* Success */}
          <div
            style={{
              marginTop: 24,
              display: "flex",
              alignItems: "center",
              gap: 10,
              opacity: successShow,
              transform: `scale(${successShow})`,
            }}
          >
            <span style={{ color: "#27c93f", fontSize: 20 }}>✓</span>
            <span style={{ color: "#27c93f", fontSize: 15 }}>
              Workspace connected — 47 files indexed, git history loaded
            </span>
          </div>
        </div>
      </div>
    </SceneContainer>
  );
};

export const WORKSPACE_DURATION = DURATION;
