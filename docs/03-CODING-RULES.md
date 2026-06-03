# Flowdesk — Coding Rules & Conventions
**Feed this to every AI session. Non-negotiable.**

---

## The Standard
This codebase must look like it was built by a single world-class engineer with 10 years of production Node.js/React experience. Consistent. Predictable. No shortcuts. No "I'll fix it later."

---

## Universal Rules (Backend + Frontend)

```
RULE 1:  No `any` type in TypeScript. Ever. Write the type or use `unknown` with a type guard.
RULE 2:  No unhandled promise rejections. Every async call has try/catch or .catch().
RULE 3:  No console.log in any committed code. Use the Pino logger on the backend.
RULE 4:  No hardcoded strings for user-visible text, config values, or API keys.
RULE 5:  No function longer than 50 lines. Extract to a named function with a clear purpose.
RULE 6:  No file longer than 300 lines. Split into focused modules.
RULE 7:  Every exported function has a JSDoc comment explaining its purpose.
RULE 8:  No commented-out code in commits. Delete it. Git history exists for a reason.
RULE 9:  Every environment variable documented in .env.example with a comment.
RULE 10: Errors are always handled explicitly — never swallowed silently.
```

---

## Backend Rules

### Architecture
```
RULE B1:  Route handlers contain zero business logic.
          They validate input → call a service → return the response. That's it.

RULE B2:  Services contain business logic only.
          No HTTP concepts (req, res, statusCode) inside a service function.

RULE B3:  All database access goes through repository functions.
          Services never call Prisma directly.
          Repository functions never contain business logic.

RULE B4:  Every API endpoint has a Zod schema for request body and query params.
          No schema = route does not get merged.

RULE B5:  Every API response uses the standard response envelope:
          { success: true, data: T, meta?: object }
          { success: false, error: string, code: string }
          Use the helpers in utils/response.ts. Never hand-build response objects.

RULE B6:  Authentication middleware runs on every protected route. No exceptions.
          A missing auth check is a security vulnerability, not a time-saving shortcut.

RULE B7:  Rate limiting at Cloudflare layer AND at application layer.
          Application rate limit: 100 requests/minute per IP, 1000/minute per authenticated business.

RULE B8:  Webhook endpoint validates Meta HMAC signature before any processing.
          Invalid signature → 401 response + log the attempt. Never process unsigned webhooks.

RULE B9:  Every BullMQ job has a defined retry strategy and a failure handler that logs.
          Jobs must never fail silently.

RULE B10: Database transactions used whenever multiple tables are written in one operation.
          If one write fails, all writes in the operation must roll back.

RULE B11: All timestamps stored in UTC.
          Conversion to Africa/Accra time (GMT+0, no DST — simple) happens only at the display layer.

RULE B12: Soft deletes only on all business data.
          No hard deletes on orders, customers, payments, messages. Ever.
          Add deletedAt to new models. Filter deletedAt IS NULL in all repository queries.

RULE B13: Prisma migrations are append-only.
          Never edit a migration that has run. Always create a new migration file.

RULE B14: Sensitive fields never returned in API responses.
          waAccessToken, passwordHash, refreshToken, inviteToken are stripped in the repository layer.
          Not in the route. Not with a frontend filter. In the repository.

RULE B15: Every external API call (Meta, Paystack, Resend, Anthropic) has:
          - A timeout set (never rely on the SDK default)
          - An explicit error handler
          - The error logged with context before rethrowing
```

### Naming (Backend)
```
Files:       kebab-case.ts              order-service.ts
Folders:     kebab-case                 order-management/
Classes:     PascalCase                 OrderService
Interfaces:  PascalCase (no I prefix)  OrderCreateInput
Types:       PascalCase                 OrderStatus
Constants:   SCREAMING_SNAKE_CASE      MAX_RETRY_ATTEMPTS
Env vars:    SCREAMING_SNAKE_CASE      META_WEBHOOK_SECRET
DB tables:   snake_case                orders, order_items
```

### Module Structure
Every module follows this exact structure:
```
modules/orders/
├── orders.route.ts     # Route registration, input validation, calls service
├── orders.service.ts   # Business logic, calls repository
├── orders.repository.ts# All Prisma queries for this domain
└── orders.schema.ts    # Zod schemas for request/response validation
```

---

## Frontend Rules

### Architecture
```
RULE F1:  No business logic in components.
          Components render UI and handle user events. That's it.

RULE F2:  All API calls go through the typed api/ layer.
          No fetch() or axios calls inside components or hooks.
          The api/ layer is the only place HTTP calls happen.

RULE F3:  All server state managed by TanStack Query.
          No useEffect for data fetching. No useState for remote data.

RULE F4:  All form state managed by React Hook Form + Zod.
          No uncontrolled inputs. No manual onChange handlers tracking state.

RULE F5:  No inline styles. Tailwind classes only.
          Custom CSS only in globals.css for root-level CSS variables.

RULE F6:  Every component that loads data has three states implemented and designed:
          - Loading state (skeleton, not spinner)
          - Error state (error message + retry option)
          - Success state (the actual content)
          Missing any of these = incomplete component.

RULE F7:  No hardcoded user-visible strings in JSX.
          All strings in src/constants/strings.ts for future i18n readiness.

RULE F8:  Every route-level page is wrapped in React.lazy() + Suspense.
          No monolithic bundle. All routes code-split.

RULE F9:  Every image has alt text. Every icon-only button has aria-label.

RULE F10: Mobile (375px) is the default. Desktop styles are additive.
          Write the mobile styles first. Use md: lg: prefixes to enhance for larger screens.
          Test every component at 375px before considering it done.

RULE F11: No prop drilling beyond 2 levels.
          If a prop needs to pass through 3+ components, use Zustand or TanStack Query.

RULE F12: Color values only via CSS variables defined in globals.css.
          Never write a hex value in a Tailwind class or JSX.
          Use: bg-[var(--color-primary)] not bg-[#3d6b52]

RULE F13: The SSE connection is a singleton per browser session.
          The useSSE hook creates the EventSource once. It is never recreated.
          Multiple components subscribe to events from the same connection.

RULE F14: Any list that could exceed 50 items uses TanStack Virtual.
          No full DOM renders of long lists. This is a performance requirement, not a preference.

RULE F15: Every API error displays a user-friendly message — not a raw error object.
          API errors are caught in the api/ layer, mapped to friendly strings, and surfaced via toast.
```

### Component Structure
```typescript
// Correct component structure

// 1. Imports
import { useState } from 'react';
import { useOrders } from '@/hooks/useOrders';
import { OrderCard } from './OrderCard';
import { OrderCardSkeleton } from './OrderCardSkeleton';

// 2. Types (local to this file)
interface OrderBoardProps {
  status: OrderStatus;
}

// 3. Component (named export, never default for components)
export function OrderBoard({ status }: OrderBoardProps) {
  // 4. Hooks first
  const { data: orders, isLoading, isError } = useOrders(status);

  // 5. Derived state (no useEffect for derived values)
  const totalValue = orders?.reduce((sum, o) => sum + Number(o.totalAmount), 0) ?? 0;

  // 6. Event handlers
  function handleCardClick(orderId: string) {
    // handle it
  }

  // 7. Render — loading, error, success in that order
  if (isLoading) return <OrderCardSkeleton count={3} />;
  if (isError) return <ErrorState onRetry={() => void refetch()} />;

  return (
    <div>
      {orders?.map((order) => (
        <OrderCard key={order.id} order={order} onClick={handleCardClick} />
      ))}
    </div>
  );
}
```

---

## Git Rules

### Branch Naming
```
feature/FD-001-webhook-receiver
feature/FD-002-intent-engine
fix/FD-015-duplicate-message-detection
chore/upgrade-bullmq-v5
docs/update-deployment-guide
```

### Commit Format
```
feat(webhook): add Meta HMAC signature validation
feat(orders): implement atomic reference number generation
feat(dashboard): add real-time order board via SSE
fix(intent): handle empty message body without crashing
fix(orders): correct stock deduction on order cancellation
refactor(customers): extract phone normalization to utility
test(intent): add Twi-English mixed language test cases
chore(deps): upgrade Prisma to 5.13
docs(api): add webhook endpoint documentation
```

### Branch Rules
- Never commit directly to `main`
- Every PR requires the checklist complete (see 06-PR-CHECKLIST.md)
- No PR merges with failing TypeScript or failing tests
- Squash commits on merge for feature branches
- Merge commits allowed for release branches

---

## AI Output Rejection Criteria

If an AI produces code with any of the following, reject it and reprompt:

```
🚫  // TODO: implement this
🚫  // ... rest of the implementation  
🚫  throw new Error('Not implemented')
🚫  : any
🚫  as any
🚫  console.log(
🚫  catch (error) { }              ← empty catch
🚫  catch (error) { console.error(error) }  ← catch with no recovery
🚫  Hardcoded hex colors in JSX or Tailwind classes
🚫  Hardcoded strings visible to users in JSX
🚫  fetch( or axios. inside a component
🚫  useEffect for data fetching
🚫  Direct prisma. calls inside a route handler
🚫  Direct prisma. calls inside a service function
🚫  HTTP req/res objects inside a service function
🚫  Missing loading state in a data-fetching component
🚫  Missing error state in a data-fetching component
🚫  Untyped function parameters
🚫  Missing return type on exported functions
🚫  setTimeout with magic number (use named constant)
🚫  Hardcoded port numbers (use env.PORT)
🚫  Hardcoded API URLs (use env config)
🚫  process.env.SOMETHING directly (always go through config/env.ts)
```
