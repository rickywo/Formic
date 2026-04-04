import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { SceneContainer } from "../components/SceneContainer";

const DURATION = 270; // 9 seconds

const SUBTASKS = [
  { type: "standard", title: "Create ThemeProvider with React Context" },
  { type: "standard", title: "Add system theme detection hook" },
  { type: "quick", title: "Implement localStorage persistence" },
  { type: "standard", title: "Build toggle button component" },
  { type: "quick", title: "Wire Tailwind dark class to HTML element" },
];

export const ArchitectScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const goalEntry = spring({
    frame,
    fps,
    config: { damping: 12, stiffness: 80 },
  });

  const thinkingPulse = Math.sin(frame * 0.15) * 0.3 + 0.7;

  const arrowEntry = spring({
    frame: Math.max(0, frame - 40),
    fps,
    config: { damping: 12, stiffness: 80 },
  });

  return (
    <SceneContainer
      durationInFrames={DURATION}
      stepNumber={6}
      heading="🏗️ Architect decomposes the goal"
      caption="One goal → 5 focused subtasks. Each executes independently."
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 40,
          width: "90%",
          maxWidth: 1400,
        }}
      >
        {/* Goal card (left) */}
        <div
          style={{
            width: 380,
            flexShrink: 0,
            borderRadius: 14,
            background: "rgba(255,255,255,0.04)",
            border: "2px solid rgba(217,119,6,0.4)",
            padding: "28px 24px",
            boxShadow: `0 0 ${30 * thinkingPulse}px rgba(217,119,6,0.15)`,
            opacity: goalEntry,
            transform: `translateX(${interpolate(goalEntry, [0, 1], [-30, 0])}px)`,
          }}
        >
          <div
            style={{
              padding: "5px 12px",
              borderRadius: 6,
              background: "linear-gradient(135deg, #d97706, #f59e0b)",
              color: "#fff",
              fontWeight: 700,
              fontSize: 11,
              letterSpacing: 1,
              display: "inline-block",
              marginBottom: 14,
            }}
          >
            🏗️ GOAL
          </div>
          <div
            style={{
              fontSize: 16,
              fontWeight: 600,
              color: "#fff",
              marginBottom: 14,
              lineHeight: 1.4,
            }}
          >
            Add dark mode toggle with system theme detection
          </div>
          <div
            style={{
              fontSize: 13,
              color: "#d97706",
              fontWeight: 500,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span style={{ opacity: thinkingPulse }}>🧠</span>
            AI Architect analyzing...
          </div>
        </div>

        {/* Arrow */}
        <div
          style={{
            fontSize: 32,
            color: "rgba(255,255,255,0.3)",
            opacity: arrowEntry,
            transform: `scaleX(${arrowEntry})`,
          }}
        >
          →
        </div>

        {/* Subtask cards (right) */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 10 }}>
          {SUBTASKS.map((task, i) => {
            const entry = spring({
              frame: Math.max(0, frame - 60 - i * 18),
              fps,
              config: { damping: 12, stiffness: 100 },
            });

            return (
              <div
                key={i}
                style={{
                  borderRadius: 10,
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  padding: "14px 18px",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  opacity: entry,
                  transform: `translateX(${interpolate(entry, [0, 1], [40, 0])}px)`,
                }}
              >
                <div
                  style={{
                    padding: "3px 10px",
                    borderRadius: 5,
                    background:
                      task.type === "quick"
                        ? "rgba(39,201,63,0.15)"
                        : "rgba(99,102,241,0.15)",
                    color: task.type === "quick" ? "#27c93f" : "#8b5cf6",
                    fontSize: 11,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                    flexShrink: 0,
                  }}
                >
                  {task.type}
                </div>
                <span style={{ color: "#e0e0e0", fontSize: 14 }}>{task.title}</span>
              </div>
            );
          })}
        </div>
      </div>
    </SceneContainer>
  );
};

export const ARCHITECT_DURATION = DURATION;
