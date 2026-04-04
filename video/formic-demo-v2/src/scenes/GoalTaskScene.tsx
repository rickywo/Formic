import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { SceneContainer } from "../components/SceneContainer";

const DURATION = 240; // 8 seconds

export const GoalTaskScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const cardEntry = spring({
    frame,
    fps,
    config: { damping: 12, stiffness: 80 },
  });

  const badgeEntry = spring({
    frame: Math.max(0, frame - 20),
    fps,
    config: { damping: 10, stiffness: 100 },
  });

  const buttonEntry = spring({
    frame: Math.max(0, frame - 50),
    fps,
    config: { damping: 12, stiffness: 80 },
  });

  const confirmEntry = spring({
    frame: Math.max(0, frame - 110),
    fps,
    config: { damping: 10, stiffness: 80 },
  });

  const glowPulse = Math.sin(frame * 0.06) * 0.3 + 0.7;

  return (
    <SceneContainer
      durationInFrames={DURATION}
      stepNumber={5}
      heading="🎯 AI creates a Goal task"
      caption="Goal tasks are automatically broken down by the AI Architect."
    >
      <div
        style={{
          width: 700,
          borderRadius: 16,
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.1)",
          padding: "36px 40px",
          boxShadow: `0 25px 60px rgba(0,0,0,0.4), 0 0 ${40 * glowPulse}px rgba(139,92,246,0.15)`,
          opacity: cardEntry,
          transform: `scale(${interpolate(cardEntry, [0, 1], [0.9, 1])})`,
        }}
      >
        {/* Goal badge */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginBottom: 20,
            opacity: badgeEntry,
            transform: `scale(${badgeEntry})`,
          }}
        >
          <div
            style={{
              padding: "6px 14px",
              borderRadius: 8,
              background: "linear-gradient(135deg, #d97706, #f59e0b)",
              color: "#fff",
              fontWeight: 700,
              fontSize: 12,
              letterSpacing: 1,
              textTransform: "uppercase",
            }}
          >
            🏗️ GOAL TASK
          </div>
          <div
            style={{
              padding: "6px 14px",
              borderRadius: 8,
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.1)",
              color: "rgba(255,255,255,0.5)",
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            Priority: Medium
          </div>
        </div>

        {/* Title */}
        <div
          style={{
            fontSize: 22,
            fontWeight: 700,
            color: "#fff",
            marginBottom: 12,
          }}
        >
          Add dark mode toggle with system theme detection
        </div>

        {/* Context preview */}
        <div
          style={{
            fontSize: 14,
            color: "rgba(255,255,255,0.4)",
            lineHeight: 1.6,
            marginBottom: 28,
          }}
        >
          Create a ThemeProvider with localStorage persistence, system preference detection via prefers-color-scheme, and a toggle component...
        </div>

        {/* Create button */}
        <div
          style={{
            opacity: buttonEntry,
            transform: `translateY(${interpolate(buttonEntry, [0, 1], [10, 0])}px)`,
          }}
        >
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "12px 28px",
              borderRadius: 10,
              background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
              color: "#fff",
              fontWeight: 600,
              fontSize: 16,
              boxShadow: "0 4px 20px rgba(99,102,241,0.4)",
            }}
          >
            Create Task →
          </div>
        </div>

        {/* Confirmation */}
        <div
          style={{
            marginTop: 24,
            display: "flex",
            alignItems: "center",
            gap: 8,
            opacity: confirmEntry,
            transform: `translateY(${interpolate(confirmEntry, [0, 1], [10, 0])}px)`,
          }}
        >
          <span style={{ fontSize: 18 }}>✨</span>
          <span style={{ color: "rgba(255,255,255,0.6)", fontSize: 15 }}>
            Task created! AI Architect will decompose this into subtasks...
          </span>
        </div>
      </div>
    </SceneContainer>
  );
};

export const GOAL_DURATION = DURATION;
