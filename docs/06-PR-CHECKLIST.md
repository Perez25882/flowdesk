# Flowdesk — PR & Definition of Done Checklist

---

## Definition of Done

A task is DONE when ALL of the following are true.  
No exceptions. No "we'll add it later."

### Code Quality
- [ ] TypeScript compiles with zero errors (`pnpm typecheck`)
- [ ] ESLint passes with zero warnings (`pnpm lint`)
- [ ] No `any` types anywhere in the changed files
- [ ] No `console.log` statements
- [ ] No TODO comments
- [ ] No commented-out code
- [ ] Every function longer than 10 lines has a clear, single responsibility
- [ ] No file exceeds 300 lines

### Architecture
- [ ] Route handlers contain zero business logic
- [ ] Services contain zero Prisma calls (only through repositories)
- [ ] Services contain zero HTTP concepts (req, res, statusCode)
- [ ] All environment variables accessed through `env` from `config/env.ts`
- [ ] All timestamps stored in UTC
- [ ] Business data uses soft deletes (`deletedAt`) not hard deletes

### Testing
- [ ] Unit tests written for all new service and utility functions
- [ ] Happy path tested
- [ ] At least 2 edge cases tested per function
- [ ] Integration test written for any new API endpoint
- [ ] All tests pass (`pnpm test`)

### API Endpoints (if applicable)
- [ ] Zod schema validates request body and query params
- [ ] Response uses standard envelope (`success`, `data`, `meta`)
- [ ] Auth middleware applied
- [ ] businessId scoping verified (can't access another business's data)
- [ ] Rate limiting in place
- [ ] Swagger documentation added

### Frontend Components (if applicable)
- [ ] Loading state implemented (skeleton, not spinner)
- [ ] Error state implemented with user-friendly message and retry option
- [ ] Empty state implemented (not a blank screen)
- [ ] Component works at 375px width (test in Chrome DevTools)
- [ ] No hardcoded strings (all in constants/strings.ts)
- [ ] No hardcoded colors (all via CSS variables)
- [ ] No inline styles
- [ ] Accessible (aria labels on icon-only buttons, alt text on images)

### Security (when relevant)
- [ ] No secrets or tokens in API responses
- [ ] HMAC signature validated before processing webhook
- [ ] Role permissions enforced server-side
- [ ] Input sanitized and validated before DB write

### Documentation
- [ ] .env.example updated if new env vars added
- [ ] JSDoc comment on every exported function
- [ ] PR description explains what changed and why (not just what)

---

## PR Template

```markdown
## What
[One sentence: what does this PR do?]

## Why
[One sentence: what problem does it solve?]

## How to Test
1. [Specific steps to verify the change works]
2. [Include any test data needed]
3. [Expected outcome]

## Checklist
- [ ] TypeScript compiles (pnpm typecheck)
- [ ] ESLint passes (pnpm lint)  
- [ ] Tests written and passing (pnpm test)
- [ ] No console.log, no any, no TODO
- [ ] .env.example updated (if new env vars)
- [ ] Loading + error + empty states (if frontend)
- [ ] Tested at 375px mobile width (if frontend)
- [ ] Auth + businessId scoping verified (if new endpoints)
```

---

## AI Output Review Process

Before merging any AI-generated code:

### Step 1: Automated checks
```bash
pnpm typecheck   # Must pass with 0 errors
pnpm lint        # Must pass with 0 warnings
pnpm test        # Must pass
```

### Step 2: Manual scan
Search for these strings — none should exist:
```
: any
as any
console.log
// TODO
// ...
// rest of
Not implemented
```

### Step 3: Architecture check
- Open each new service file — does it import from `@prisma/client` or `db`? If yes, reject.
- Open each new route file — does it contain business logic? If yes, reject.
- Open each new component — does it call `fetch()` directly? If yes, reject.

### Step 4: Test the UI
- Open Chrome DevTools → set device to 375px
- Walk through every new UI element at mobile size
- Every interaction must work without horizontal scroll

### Step 5: Security spot check (for any auth or webhook related changes)
- Is the HMAC validation still in place?
- Is businessId checked on every DB query in changed repositories?
- Are there any new endpoints that should be protected but aren't?

---

## Version Control Rules

### What goes in a commit
- One logical change per commit
- "feat(orders): add status history tracking" — clear, specific
- Not "various fixes" or "wip" or "stuff"

### What never goes in a commit
- .env file (any of them)
- node_modules
- dist/build output
- Prisma generated client
- API keys of any kind

### Branch lifecycle
- Create: from main, named feature/FD-XXX-description
- Work: commit as you go
- Before PR: rebase on main, squash to clean commits
- After merge: delete branch immediately

---

## Release Checklist

Before deploying to production:

- [ ] All Phase X tasks marked Done in implementation plan
- [ ] `pnpm build` completes with zero errors
- [ ] All environment variables set in production env
- [ ] `pnpm prisma migrate deploy` run successfully
- [ ] Health check endpoint returning 200
- [ ] Sentry initialized and receiving test event
- [ ] Redis connection verified
- [ ] PM2 ecosystem file updated if new services added
- [ ] At least one real end-to-end test on staging before production
