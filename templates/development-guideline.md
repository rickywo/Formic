# AI Development Guidelines

## 1. Project Overview
- **Type:** [e.g., Chrome Extension / Next.js Web App / Python Automation Script]
- **Core Stack:** [e.g., React, TypeScript, TailwindCSS, Vite] / [Python, Pandas, FastAPI]
- **Primary Goal:** [One sentence summary of what the software does]

## 2. Architectural Patterns
- **State Management:** [e.g., Use React Context for global state; local state for components]
- **File Structure:** - `/src/components`: Reusable UI components
    - `/src/lib`: Utility functions and helpers
    - `/src/features`: Feature-specific logic
- **Design Pattern:** [e.g., Functional composition over inheritance; Mobile-first design]

## 3. Coding Standards (Strict)
- **Language:** [e.g., TypeScript strict mode enabled; No `any` types]
- **Styling:** [e.g., Tailwind classes only; no CSS modules unless necessary]
- **Naming:** - Variables/Functions: `camelCase` (descriptive, no abbreviations like `ctx` or `res`)
    - Components/Classes: `PascalCase`
    - Constants: `SCREAMING_SNAKE_CASE`
- **Error Handling:** [e.g., Wrap async calls in try/catch; Log errors to console with "[Error]: " prefix]

## 4. Preferred Libraries & Tools
- **Routing:** [e.g., React Router v6]
- **Testing:** [e.g., Vitest for unit tests; Playwright for E2E]
- **API Fetching:** [e.g., Axios / TanStack Query]
- **Validation:** [e.g., Zod]

## 5. Development Workflow (The "Plan-Act" Loop)
1. **Analysis:** Before writing code, analyze the file structure and existing imports.
2. **Thinking:** Use `thinking` mode to outline the implementation steps.
3. **Execution:** Implement changes incrementally.
4. **Verification:**
    - Run `npm run lint` to check for style issues.
    - Run `npm run test` to verify no regressions.
    - *Only* submit code after these checks pass.

## 6. Build & Test Commands
- **Start Dev Server:** `npm run dev`
- **Run Tests:** `npm run test`
- **Build Production:** `npm run build`
- **Lint Code:** `npm run lint`

## 7. Forbidden Practices 🛑
- Do not use `useEffect` without a comprehensive dependency array.
- Do not remove comments that start with `TODO:` or `FIXME:`.
- Do not introduce new dependencies without explicit permission.
- Do not leave console logs (`console.log`) in production code.