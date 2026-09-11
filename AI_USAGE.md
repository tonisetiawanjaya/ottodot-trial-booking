# AI usage

## Which AI tools I used

- **Claude Code**, Anthropic's coding agent, in the Claude desktop app. The build ran on the Claude Fable 5.1 model. From the video preparation onward I switched to Claude Opus 5. Each commit's `Co-Authored-By` line shows which model was involved.
- **ChatGPT**, OpenAI's assistant, for brainstorming.

## What I used AI for

- **The build.** I gave it the brief as a `.docx` and asked it to build the solution. It designed the data model, wrote the code, the tests and the seed data, and wrote the first drafts of the README and this file.
- **Changes I asked for after the first version worked:**
  - a cleaner booking flow, with one screen per step and live seat counts;
  - real username and password logins, with live updates;
  - retrying refunds that the payment provider fails to process;
  - Codespaces and CI, so a reviewer can run and verify it without installing anything.
- **Checking the work against the brief**, and fixing what an independent review found (see below).
- **The walkthrough video.** I recorded the screen and my narration separately. The AI lined them up, reduced the fan noise in my phone recording, and compressed the result for upload.
- **Publishing.** Setting my commit identity, keeping my email address private on GitHub, and pushing.

## One place where AI helped me move faster

The last-seat race test. The brief describes an exact order of events: A starts paying, B starts paying, B finishes first, then A finishes. The AI put the payment provider behind a small interface and wrote a test version whose charges complete only when the test says so. That turned the race into a plain step-by-step test with no timers: start A, start B, complete B and check it is confirmed, complete A and check it is refunded. The same approach made the other awkward cases easy to test, such as a declined card on the winning side or a refund provider that is down. A separate test sends twelve families after the last seat at once, with random delays, to cover the timing-based version.

## One place where I disagreed with, corrected, or rejected AI output

**Leaving login out.** The AI's first version had no login on purpose. A "signed in as" dropdown let you pick any parent, and authentication was listed under *what I deliberately cut*. That is a fair reading of the brief, but I rejected it for the demo. I asked for real username and password logins, so the demo would behave like a real website and update in real time. The result is enforced accounts, sessions and per-family ownership checks instead of an assumption in the README. It also means the last-seat race can be shown between two separately logged-in parents, with both pages updating as it happens. It cost a larger change than the brief needed, and the README's *Time spent* section says so.

**Not taking "all tests pass" on trust.** The AI reported that all tests passed. Before submitting, I exported the project and had it reviewed against the brief in a different environment. On Node 22.16 the tests did not even load. Running TypeScript without a flag only became the default in Node 22.18, and the AI had only ever run the tests on Node 24. The fix was to pass the flag explicitly in every script, add a version check with a clear message, and add a Dockerfile. Later I asked for CI as well, and it now runs the tests on both Node 22.13 and Node 24 on every push.

## What I would change about my AI workflow next time

- **Decide the demo scope in the first prompt.** Adding login after the core was built touched 18 files. Asking for it at the start would have put accounts in the data model from the beginning.
- **Test on the oldest Node version I claim to support, from the start.** The version problem was invisible on my own machine until someone ran it elsewhere.
- **Record the screen and my voice together, with a proper microphone.** Recording them separately meant lining them up afterwards and removing a lot of fan noise.

## How I verified the final implementation

- `npm test` runs 49 tests. They cover the booking rules, login and ownership, refund retries, the database constraints tested directly, and real HTTP requests with cookies and live updates.
- `npm run typecheck` is clean under strict TypeScript, and `npm run demo:race` prints the race step by step and checks that no class goes over four.
- **CI on GitHub Actions** runs all of it on Node 22.13 and Node 24 on every push. The tests run before any `npm install`, which checks the zero-dependency claim.
- **A fresh clone from GitHub**, with no database folder, starts with `npm start`, creates and seeds its own database, and serves the expected seat counts.
- **The independent review** of an exported copy, described above, which found the Node version problem.
- **The AI drove the app in a browser** as two logged-in families and reproduced each edge case. That run caught a mistake in the README: two tabs in one browser share a login, so the race needs two browsers.
- **I ran the app myself** to record the walkthrough video.
