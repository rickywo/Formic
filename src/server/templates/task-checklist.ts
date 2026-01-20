/**
 * Generate CHECKLIST.md content for a task documentation folder
 */
export function generateTaskChecklist(title: string, _context: string): string {
  return `# ${title} - Checklist

## Pre-Implementation

- [ ] Requirements understood
- [ ] Approach decided
- [ ] Dependencies identified

## Implementation

- [ ] Core functionality complete
- [ ] Error handling added
- [ ] Code compiles without errors

## Quality Gates

- [ ] Implementation tested
- [ ] Edge cases verified
- [ ] No regressions introduced

## Completion

- [ ] PLAN.md updated with progress
- [ ] Output artifacts saved to output/
- [ ] Ready for review

---

**Status: PENDING**
`;
}
