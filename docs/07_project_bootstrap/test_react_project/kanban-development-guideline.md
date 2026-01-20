# AI Development Guidelines

## 1. Project Overview

- **Type:** React Dashboard Web Application
- **Core Stack:** React 18.2.0, TypeScript 5.3.3, Vite 5.0.12, TailwindCSS 3.4.1
- **Primary Goal:** A modern dashboard application for displaying and managing data with a clean, responsive UI

## 2. Architectural Patterns

### State Management
- **Server State:** TanStack Query (React Query) v5.17.0 for async data fetching, caching, and synchronization
- **Client State:** Zustand v4.5.0 for global application state
- **Local State:** React's built-in `useState` for component-scoped state

### File Structure
```
/src
├── /components      # Reusable UI components (Button, Input, Modal, etc.)
├── /hooks           # Custom React hooks (useApi, useAuth, etc.)
├── /types           # TypeScript type definitions and interfaces
├── /utils           # Utility functions and helpers (not yet created)
├── /__tests__       # Test files colocated by feature
└── App.tsx          # Root application component with providers
```

### Path Aliases (configured in tsconfig.json & vite.config.ts)
- `@/*` → `src/*`
- `@components/*` → `src/components/*`
- `@hooks/*` → `src/hooks/*`
- `@utils/*` → `src/utils/*`
- `@types/*` → `src/types/*`

### Design Patterns
- **Functional components only** - No class components
- **Composition over inheritance** - Prefer composing components and hooks
- **Props interface pattern** - Extend native HTML element attributes (e.g., `ButtonHTMLAttributes<HTMLButtonElement>`)
- **Provider pattern** - Wrap root app with QueryClientProvider and BrowserRouter

## 3. Coding Standards (Strict)

### Language Rules
- **TypeScript strict mode enabled** - All strict checks active
- **No `any` types** - ESLint rule `@typescript-eslint/no-explicit-any: error`
- **No unused variables** - `noUnusedLocals: true`, `noUnusedParameters: true`
- **Explicit return types** - `@typescript-eslint/explicit-function-return-type: warn`
- **JSX return type** - Use `JSX.Element` as component return type

### Styling Rules
- **TailwindCSS classes only** - Use utility classes for all styling
- **clsx for conditional classes** - Import from `clsx` package
- **Custom theme colors** - Defined in `tailwind.config.js` under `theme.extend.colors`

### Naming Conventions
| Type | Convention | Example |
|------|------------|---------|
| Variables/Functions | `camelCase` | `handleClick`, `userData` |
| Components | `PascalCase` | `Button`, `UserProfile` |
| Interfaces/Types | `PascalCase` | `ButtonProps`, `ApiResponse` |
| Constants | `SCREAMING_SNAKE_CASE` | `MAX_RETRY_COUNT` |
| Files (components) | `PascalCase.tsx` | `Button.tsx` |
| Files (hooks) | `camelCase.ts` | `useApi.ts` |
| Files (types) | `camelCase.ts` or `index.ts` | `index.ts` |

### Error Handling
- Wrap async operations in try/catch blocks
- Use `console.warn` and `console.error` only (no `console.log` in production)
- Handle API errors through TanStack Query's built-in error states

### Code Formatting (Prettier)
```json
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "es5",
  "printWidth": 100,
  "bracketSpacing": true,
  "arrowParens": "avoid",
  "endOfLine": "lf"
}
```

## 4. Preferred Libraries & Tools

| Purpose | Library | Version |
|---------|---------|---------|
| **Build Tool** | Vite | ^5.0.12 |
| **UI Framework** | React | ^18.2.0 |
| **Type Safety** | TypeScript | ^5.3.3 |
| **Styling** | TailwindCSS | ^3.4.1 |
| **Routing** | React Router | ^6.22.0 |
| **Server State** | TanStack Query | ^5.17.0 |
| **Client State** | Zustand | ^4.5.0 |
| **HTTP Client** | Axios | ^1.6.5 |
| **Date Handling** | date-fns | ^3.3.0 |
| **Class Merging** | clsx | ^2.1.0 |
| **Unit Testing** | Vitest | ^1.2.1 |
| **Component Testing** | Testing Library | ^14.1.2 |
| **Linting** | ESLint | ^8.56.0 |
| **Formatting** | Prettier | ^3.2.4 |

## 5. Development Workflow (The "Plan-Act" Loop)

1. **Analysis:** Before writing code, analyze the file structure and existing imports. Use path aliases (`@/`, `@components/`, etc.) consistently.

2. **Thinking:** Outline the implementation steps:
   - What components/hooks need to be created or modified?
   - What types need to be defined?
   - How will state be managed?

3. **Execution:** Implement changes incrementally:
   - Create types first in `src/types/`
   - Build reusable components in `src/components/`
   - Create custom hooks in `src/hooks/`
   - Integrate in parent components/pages

4. **Verification:**
   - Run `npm run lint` to check for style issues
   - Run `npm run test` to verify no regressions
   - Run `npm run format` to ensure consistent formatting
   - *Only* submit code after these checks pass

## 6. Build & Test Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite development server on port 3000 |
| `npm run build` | Type-check with tsc then build for production |
| `npm run preview` | Preview production build locally |
| `npm run test` | Run tests with Vitest |
| `npm run test:coverage` | Run tests with coverage report |
| `npm run lint` | Lint TypeScript/TSX files in src/ |
| `npm run lint:fix` | Lint and auto-fix issues |
| `npm run format` | Format code with Prettier |

## 7. Testing Guidelines

### Test File Location
- Place tests in `src/__tests__/` directory
- Name test files with `.test.tsx` or `.test.ts` suffix

### Testing Stack
- **Test Runner:** Vitest
- **Component Testing:** @testing-library/react
- **DOM Assertions:** @testing-library/jest-dom
- **Mocking:** Vitest's built-in `vi.fn()`

### Test Structure
```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

describe('ComponentName', () => {
  it('describes expected behavior', () => {
    // Arrange
    render(<Component />);

    // Act
    fireEvent.click(screen.getByRole('button'));

    // Assert
    expect(screen.getByText('Expected')).toBeInTheDocument();
  });
});
```

### What to Test
- Component renders correctly with different props
- User interactions (clicks, inputs, form submissions)
- Loading and error states
- Conditional rendering logic

## 8. API Integration Patterns

### Using the Custom API Hooks
```typescript
// GET request with TanStack Query
const { data, isLoading, error } = useApiGet<User[]>(
  ['users'],           // Query key for caching
  '/users',            // API endpoint
  true                 // enabled flag
);

// POST request with TanStack Query
const mutation = useApiPost<User, CreateUserDto>('/users');
mutation.mutate({ name: 'John', email: 'john@example.com' });
```

### API Response Type
All API responses should follow the `ApiResponse<T>` interface:
```typescript
interface ApiResponse<T> {
  data: T;
  status: 'success' | 'error';
  message?: string;
}
```

## 9. Forbidden Practices

### React Hooks
- Do NOT use `useEffect` without a comprehensive dependency array
- Do NOT violate the Rules of Hooks (conditional hooks, hooks in loops)
- Always include all dependencies in `useEffect`, `useMemo`, `useCallback`

### Code Quality
- Do NOT use `any` type - define proper interfaces
- Do NOT leave `console.log` in production code (use `console.warn` or `console.error` if needed)
- Do NOT introduce new dependencies without explicit permission
- Do NOT remove comments that start with `TODO:` or `FIXME:`

### TypeScript
- Do NOT use type assertions (`as`) unless absolutely necessary
- Do NOT use `@ts-ignore` or `@ts-expect-error` without explanation
- Do NOT disable ESLint rules inline without justification

### Architecture
- Do NOT mix server state and client state management patterns
- Do NOT bypass the QueryClient for API calls
- Do NOT hardcode API URLs - use environment variables (`VITE_API_URL`)

### Styling
- Do NOT use inline styles - use TailwindCSS classes
- Do NOT create CSS files unless absolutely necessary
- Do NOT use `!important` in Tailwind classes

### Git
- Do NOT commit directly to main/master branch
- Do NOT commit files with secrets or environment variables
- Do NOT commit with failing tests or lint errors

## 10. Environment Variables

Environment variables must be prefixed with `VITE_` to be exposed to the client:
```
VITE_API_URL=https://api.example.com
```

Access in code:
```typescript
const apiUrl = import.meta.env.VITE_API_URL || '/api';
```

## 11. Component Template

Use this template when creating new components:

```typescript
import { type ReactNode, type HTMLAttributes } from 'react';
import clsx from 'clsx';

interface ComponentNameProps extends HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'alternative';
  children: ReactNode;
}

export function ComponentName({
  variant = 'default',
  children,
  className,
  ...props
}: ComponentNameProps): JSX.Element {
  return (
    <div
      className={clsx(
        'base-styles',
        variant === 'alternative' && 'alternative-styles',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}
```

## 12. Custom Hook Template

Use this template when creating new hooks:

```typescript
import { useState, useCallback } from 'react';

interface UseHookNameOptions {
  initialValue?: string;
}

interface UseHookNameReturn {
  value: string;
  setValue: (newValue: string) => void;
  reset: () => void;
}

export function useHookName(options: UseHookNameOptions = {}): UseHookNameReturn {
  const { initialValue = '' } = options;
  const [value, setValue] = useState(initialValue);

  const reset = useCallback((): void => {
    setValue(initialValue);
  }, [initialValue]);

  return { value, setValue, reset };
}
```

---

*Generated for the React Dashboard App project. Last updated: January 2026.*
