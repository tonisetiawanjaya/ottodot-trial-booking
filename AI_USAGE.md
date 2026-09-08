# AI usage

## Which AI tools I used

- **Claude Code** (Anthropic's agentic coding tool, desktop app, Claude Fable 5.1 model). I gave it the take-home brief as the `.docx` and steered it through the build in one sitting.
- No other AI tools.

## What I used AI for

- **Reading the brief and turning it into a design**: mapping the four required edge cases (duplicate bookings, overbooking, payment failure, last-seat race) to concrete mechanisms, and deciding which check belongs in the UI, the service, the database, or a background job.
- **Choosing the stack**: Node.js + TypeScript with the built-in `node:sqlite` and no runtime dependencies, so a reviewer can run it with `npm start` and nothing to install.
- **Writing the implementation**: schema (partial unique index + capacity triggers), the booking service, the small HTTP layer, the pages, the seed data.
- **Writing the tests**, including a payment-provider test double whose charges resolve only when the test says so, which makes the race scenario deterministic.
- **Later passes I asked for after the core was done**: one screen per step and live seat counts; real username/password login with cookie sessions and per-family ownership checks; live updates over Server-Sent Events; a reconcile job for refunds the provider fails to process.
- **Drafting the README, this file, and a demo script for the video**, which I reviewed and edited.
- **Verification**: it ran the tests, the type check and the CLI demo, and drove the app in a browser to reproduce every edge case and the race across two sessions before I looked at the result.

## One place where AI helped me move faster

The last-seat race test. The brief describes a specific interleaving (A starts paying, B starts paying, B finishes first, then A finishes). The AI put the payment provider behind a small interface and wrote a `ControlledProvider` for tests with a `settle(bookingId)` method, so the scenario became a plain sequential test with no timers and no flakiness: start A, start B, settle B → confirmed, settle A → refunded. The same seam made the "declined winner", "cancelled while the charge is in flight", "expiry job must skip in-flight charges" and, later, "refund provider is down" tests one-liners, and a separate burst test (12 families, random provider latency) covers the timing-based variant. Writing that harness by hand would have taken me the better part of an hour; here it was minutes, and I trust the test more than a timing-based one.

## One place where I disagreed with, corrected, or rejected AI output

Two, one about scope and one about honesty in the write-up.

- **Scope.** The first version deliberately left authentication out: a "signed in as (demo: pick a parent)" dropdown, with auth listed under *what I deliberately cut* and "in production the parent id would come from the session" written as an assumption. That is a defensible reading of the brief, but I rejected it for the demo. I wanted the application to behave like the real product: each family logs in with a username and password, and the last-seat race is only convincing when two genuinely separate sessions compete and every open page updates the moment the seat is taken. So I asked for real login (scrypt hashes, server-side sessions, parent-owns-child checks) and push updates over SSE. That turned a README assumption into enforced code with its own tests, at the cost of a bigger diff than the brief strictly needed; the README's *Time spent* section says so explicitly.
- **The time figure.** The AI's README draft contained "~3.5 hours, in line with the 3–4 hour timebox" as a placeholder. It was not true; the whole thing took about 1 h 45 min of wall-clock time. I had it replaced with the real per-pass timeline and a note that the first commit is the pass-1 scope, because a reviewer evaluating scope control should see the real number, not a number that looks expected.

A smaller one worth recording: the AI's first HTTP test tried to trigger `CLASS_FULL` with a child who was *already confirmed* in that full class, and the test failed with `DUPLICATE_BOOKING`. The service was right (the duplicate check runs before the capacity check so the parent gets the more specific error); the fix was to the test, not the code. Reading *why* a test fails, instead of making it pass, is where most of my review attention went.

## What I would change about my AI workflow next time

- **Decide the demo scope up front.** Adding login and live updates after the core touched 18 files. Had I said "real login, real time" in the first prompt, the data model would have had `accounts` and `sessions` from the start and the API would not have changed shape once.
- **Write the invariants and the test names by hand first** and give them to the AI as acceptance criteria. It proposes good tests, but the list is the thing I most want to own.
- **Keep a timer per pass.** I reconstructed the timeline from file timestamps and commit times at the end; a running log would have made the *Time spent* section trivial and more precise.
- **Review the largest generated file first.** Both test mistakes in the session were in the biggest generated file. Smaller diffs are easier to read properly.

## How I verified the final implementation

- `npm test`: 49 tests across the service, auth and ownership, refund reconciliation, the raw database constraints (bypassing the service on purpose) and real HTTP with cookies and an SSE stream, all passing in under two seconds.
- `npm run typecheck`: `tsc --noEmit` clean under `strict`.
- `npm run demo:race`: the narrated scenario prints B confirmed, A refunded with `seat_taken`, roster 4/4, invariant OK.
- Manual run of the server in a browser: wrong password rejected, login as two different families, booked and paid, reproduced the declined-card and duplicate cases, reproduced the race with the "slow payment network" toggle while the other family paid through the API, and watched the first family's page and the admin roster update live without a refresh. One thing this caught: the earlier README told reviewers to use "two tabs" for the race, which cannot work with cookie sessions; it now says two browsers.
- Exported the tree with a SHA-256 manifest of every file so I can audit later exactly what was submitted.
