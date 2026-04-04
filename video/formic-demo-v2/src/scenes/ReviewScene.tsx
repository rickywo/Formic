import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { SceneContainer } from "../components/SceneContainer";

const DURATION = 240; // 8 seconds

const COMPLETED_TASKS = [
  { title: "Create ThemeProvider with React Context", files: 3, lines: 85 },
  { title: "Add system theme detection hook", files: 2, lines: 62 },
  { title: "Implement localStorage persistence", files: 1, lines: 28 },
  { title: "Build toggle button component", files: 2, lines: 95 },
  { title: "Wire Tailwind dark class to HTML", files: 2, lines: 60 },
];

export const ReviewScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const headerEntry = spring({
    frame,
    fps,
    config: { damping: 12, stiffness: 80 },
  });

  const buttonEntry = spring({
    frame: Math.max(0, frame - 130),
    fps,
    config: { damping: 10, stiffness: 80 },
  });

  return (
    <SceneContainer
      durationInFrames={DURATION}
      stepNumber={8}
      heading="✅ Voilà! Ready for review"
      caption="Review the code, approve, and ship. It's that simple."
    >
      <div
        style={{
          width: 800,
          borderRadius: 16,
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(39,201,63,0.2)",
          padding: "32px 36px",
          boxShadow: "0 25px 60px rgba(0,0,0,0.4), 0 0 40px rgba(39,201,63,0.08)",
          opacity: headerEntry,
          transform: `scale(${interpolate(headerEntry, [0, 1], [0.9, 1])})`,
        }}
      >
        {/* Header */}
        <div
          style={{
            fontSize: 22,
            fontWeight: 700,
            color: "#fff",
            marginBottom: 24,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span>🎉</span> All 5 subtasks complete!
        </div>

        {/* Task list */}
        {COMPLETED_TASKS.map((task, i) => {
          const rowEntry = spring({
            frame: Math.max(0, frame - 15 - i * 12),
            fps,
            config: { damping: 12, stiffness: 100 },
          });

          return (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 0",
                borderBottom:
                  i < COMPLETED_TASKS.length - 1
                    ? "1px solid rgba(255,255,255,0.05)"
                    : "none",
                opacity: rowEntry,
                transform: `translateX(${interpolate(rowEntry, [0, 1], [20, 0])}px)`,
              }}
            >
              <span style={{ color: "#27c93f", fontSize: 16 }}>✓</span>
              <span style={{ color: "#e0e0e0", fontSize: 14, flex: 1 }}>
                {task.title}
              </span>
              <span
                style={{
                  color: "rgba(255,255,255,0.3)",
                  fontSize: 12,
                  fontFamily: "monospace",
                }}
              >
                {task.files} files · +{task.lines} lines
              </span>
            </div>
          );
        })}

        {/* Stats bar */}
        <div
          style={{
            marginTop: 20,
            padding: "14px 0",
            borderTop: "1px solid rgba(255,255,255,0.08)",
            display: "flex",
            gap: 28,
            justifyContent: "center",
          }}
        >
          {[
            { label: "Files Changed", value: "10" },
            { label: "Lines Added", value: "+330" },
            { label: "Commits", value: "5" },
            { label: "Time Taken", value: "4 min" },
          ].map((stat, i) => (
            <div key={i} style={{ textAlign: "center" }}>
              <div style={{ color: "#8b5cf6", fontSize: 18, fontWeight: 700 }}>
                {stat.value}
              </div>
              <div
                style={{
                  color: "rgba(255,255,255,0.4)",
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  marginTop: 2,
                }}
              >
                {stat.label}
              </div>
            </div>
          ))}
        </div>

        {/* Approve button */}
        <div
          style={{
            marginTop: 20,
            textAlign: "center",
            opacity: buttonEntry,
            transform: `scale(${buttonEntry})`,
          }}
        >
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "12px 36px",
              borderRadius: 10,
              background: "linear-gradient(135deg, #059669, #27c93f)",
              color: "#fff",
              fontWeight: 700,
              fontSize: 16,
              boxShadow: "0 4px 20px rgba(39,201,63,0.3)",
            }}
          >
            ✓ Approve
          </div>
        </div>
      </div>
    </SceneContainer>
  );
};

export const REVIEW_DURATION = DURATION;
