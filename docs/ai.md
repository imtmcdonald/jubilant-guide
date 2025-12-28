# Working with AI (Guidelines)

These guidelines keep AI-assisted work safe, reviewable, and reproducible.

## Do not share

- API keys, tokens, passwords, private URLs, or internal endpoints
- Personal data (PII), customer/user data, or production logs with identifiers
- Proprietary source code you don’t have rights to share

Use `.env.example` and redacted samples instead.

## What AI is good for (here)

- Drafting scaffolding, refactors, and docs
- Generating test cases and edge-case checklists
- Explaining unfamiliar code and proposing alternatives

## Required human checks

- Security/auth, permissions, payments, and data handling
- Dependency and license compatibility
- Correctness: add/adjust tests or run manual checks for the changed paths

## “Done” checklist for AI-assisted changes

- No secrets added to the repo (including sample configs)
- Builds/runs locally for the target app
- Any new behavior is documented in the app’s `README.md`
- Generated code is reviewed for correctness, error handling, and security

