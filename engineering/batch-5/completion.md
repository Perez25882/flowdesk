# Batch 5 completion register

Verified starting point `ed104ecc051e351e5c8f4287b4d44f8bf33e9b43` on `codex/batch-5-product`, equal to GitHub. The checkpoint descends from the approved Batch 4 runtime. The separate `launch` worktree has 44 pre-existing edits.

| Workstream | Dependency | Responsible | Actual state | Acceptance evidence |
| --- | --- | --- | --- | --- |
| A. Conversation ownership and read state | Existing customer/message identities and authorised inbox roles | Engineering | Implemented, verification in progress | Initial disposable API suites passed 10 then 11 cases. Compiled browser verified SSE reassignment before stopping at the assignment select label, which has been repaired. |
| B. Uninterrupted retail | Compiled API, UI and synthetic providers | Engineering | Browser fixture implemented, fresh repeat pending | First run reached verified settlement, exact stock decrement and pickup. It awaited the wrong outbound key for completion. The fixture now checks the worker's exact key. |
| C. Remaining journeys | Existing service, finance, auth and report contracts | Engineering | Partial | Real PostgreSQL tenant report, CSV, customer search and stale role checks passed. Owner adjustment was added to the commerce browser fixture. Service exceptions and in-flight financial privilege tests remain open. |
| D. Reachable controls | Compiled UI by role and profile | Engineering | Open | Baseline surface audit exists |
| E. Accessibility | Compiled UI, Axe, keyboard, assistive technology availability | Engineering and human tester if needed | Open | Baseline sampled five pages |
| F. Performance and resilience | Disposable PostgreSQL and Redis, scale fixture and browsers | Engineering | Open | Report lists baseline scale measurements |
| G. Security and regression | Final implementation and fresh services | Engineering | Open | Earlier 453 checks are historical |
| H. Documentation and handoff | Working changes and final executed evidence | Engineering | In progress | This register and the conversation contract |
