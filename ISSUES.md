# Pre-Launch Issues

Tracked issues to resolve before making the repository public on GitHub.

---

## Critical

### #1 - Leaked secrets in `.env.bup` (git history)
**Status:** Open
**Priority:** Critical

`.env.bup` is tracked in git and contains:
- A real Gemini API key
- A Google Cloud service account private key
- A GitHub personal access token

**Action required:**
1. Rotate all three credentials immediately
2. `git rm --cached .env.bup` and add `*.bup` to `.gitignore`
3. Use `git filter-repo` or BFG Repo Cleaner to scrub the file from git history before pushing public

---

### #2 - Opaque commit history
**Status:** Open
**Priority:** Critical

Every recent commit message is just `-m`. Contributors and security auditors cannot understand what changed.

**Action required:**
- Squash into a single initial commit, or rewrite messages before public push

---

## High

### #3 - Admin password stored in plaintext
**Status:** Open
**Priority:** High

The admin password is stored as-is in `.env` and compared directly (no hashing). For a self-hosted bot this is low risk, but sets a bad example for a public repo.

**Action required:**
- Hash the password with bcrypt on setup and compare hashes on login

---

### #4 - No test suite
**Status:** Resolved
**Priority:** High

Basic test suite added (35 unit tests) covering core pure modules: pricing-config, persona-parser, whatsapp-utils, phone-number-replacer, message-processor. Uses Node.js built-in test runner (`node:test`) — zero extra dependencies. Run with `npm test`.

---

### #5 - Baileys ToS risk not disclosed
**Status:** Resolved
**Priority:** High

README disclaimer expanded to explicitly mention ToS violation, account ban risk, and the recommendation to use a dedicated phone number.

---

## Medium

### #6 - No input validation on persona files
**Status:** Open
**Priority:** Medium

Malformed `.persona` files could crash the parser. Adding basic validation would prevent confusing errors for users.

---

### #7 - Express 5.x is still in beta/RC
**Status:** Open
**Priority:** Medium

The project uses `express@^5.2.1`. Express 5 has been in pre-release for years. Consider sticking with Express 4.x for stability, or at least pinning the exact version.

---

### #8 - No dev dependencies (linting/formatting)
**Status:** Won't fix
**Priority:** Medium

No linter, formatter, or type checking configured. Deferred — not needed until there are active contributors.

---

### #9 - Shell scripts assume specific paths
**Status:** Resolved
**Priority:** Medium

Personal deployment scripts removed from tracking and added to `.gitignore`.
