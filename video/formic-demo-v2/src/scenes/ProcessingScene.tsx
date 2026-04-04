import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { SceneContainer } from "../components/SceneContainer";

const DURATION = 240; // 8 seconds

interface KanbanColumn {
  title: string;
  color: string;
  tasks: string[];
}

const COLUMNS: KanbanColumn[] = [
  { title: "Queued", color: "#6366f1", tasks: ["Wire Tailwind dark class"] },
  { title: "Briefing", color: "#f59e0b", tasks: ["Build toggle component"] },
  { title: "Planning", color: "#8b5cf6", tasks: ["System theme hook"] },
  {
    title: "Running",
    color: "#27c93f",
    tasks: ["ThemeProvider Context", "localStorage persistence"],
  },
];

export const ProcessingScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const glowPulse = Math.sin(frame * 0.1) * 0.4 + 0.6;

  return (
    <SceneContainer
      durationInFrames={DURATION}
      stepNumber={7}
      heading="⚡ Tasks execute in parallel"
      caption="AI agents work through each stage — briefing, planning, and coding."
    >
      <div
        style={{
          display: "flex",
          gap: 20,
          width: "90%",
          maxWidth: 1300,
        }}
      >
        {COLUMNS.map((col, colIdx) => {
          const colEntry = spring({
            frame: Math.max(0, frame - colIdx * 12),
            fps,
            config: { damping: 12, stiffness: 80 },
          });

          return (
            <div
              key={colIdx}
              style={{
                flex: 1,
                borderRadius: 12,
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.06)",
                padding: "16px 14px",
                opacity: colEntry,
                transform: `translateY(${interpolate(colEntry, [0, 1], [30, 0])}px)`,
              }}
            >
              {/* Column header */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 14,
                  paddingBottom: 12,
                  borderBottom: "1px solid rgba(255,255,255,0.06)",
                }}
              >
                <div
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: col.color,
                  }}
                />
                <span style={{ color: "#fff", fontWeight: 600, fontSize: 14 }}>
                  {col.title}
                </span>
                <span
                  style={{
                    marginLeft: "auto",
                    background: "rgba(255,255,255,0.08)",
                    color: "rgba(255,255,255,0.5)",
                    borderRadius: 10,
                    padding: "2px 8px",
                    fontSize: 12,
                    fontWeight: 500,
                  }}
                >
                  {col.tasks.length}
                </span>
              </div>

              {/* Tasks */}
              {col.tasks.map((task, taskIdx) => {
                const taskEntry = spring({
                  frame: Math.max(0, frame - colIdx * 12 - 20 - taskIdx * 10),
                  fps,
                  config: { damping: 12, stiffness: 100 },
                });

                const isRunning = col.title === "Running";

                return (
                  <div
                    key={taskIdx}
                    style={{
                      borderRadius: 8,
                      background: "rgba(255,255,255,0.04)",
                      border: isRunning
                        ? `1px solid rgba(39,201,63,${0.3 * glowPulse})`
                        : "1px solid rgba(255,255,255,0.06)",
                      padding: "12px 14px",
                      marginBottom: 8,
                      opacity: taskEntry,
                      transform: `translateY(${interpolate(taskEntry, [0, 1], [15, 0])}px)`,
                      boxShadow: isRunning
                        ? `0 0 ${15 * glowPulse}px rgba(39,201,63,0.1)`
                        : "none",
                    }}
                  >
                    <div style={{ color: "#e0e0e0", fontSize: 13, marginBottom: 8 }}>
                      {task}
                    </div>
                    {isRunning && (
                      <div
                        style={{
                          height: 4,
                          borderRadius: 2,
                          background: "rgba(255,255,255,0.06)",
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            height: "100%",
                            borderRadius: 2,
                            background: `linear-gradient(90deg, #27c93f, #6366f1)`,
                            width: `${Math.min(95, (frame / DURATION) * 130)}%`,
                            transition: "width 0.3s ease",
                          }}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </SceneContainer>
  );
};

export const PROCESSING_DURATION = DURATION;
