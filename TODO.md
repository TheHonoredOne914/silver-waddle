# Production-Readiness TODO (Answers + Deployment Safety)

## Backend (API, Auth, SSE, Security)
- [ ] Implement full Supabase JWT verification (currently auth gate is “presence check”).
- [ ] Add automated tests for auth behavior:
  - [ ] Missing token (prod): 401 when secret enabled
  - [ ] Invalid token (prod): 401
  - [ ] Valid token (prod): allowed
- [ ] Confirm CORS behavior in production:
  - [ ] Ensure OPTIONS preflight works
  - [ ] Ensure SSE EventSource requests aren’t blocked by proxy rules
- [ ] SSE hardening:
  - [ ] Add/verify “done” + terminal error events always terminate streams
  - [ ] Add regression tests for client disconnect handling

## Backend (Answer Generation Assurance)
- [ ] Add a production smoke test that validates “answers are generated”:
  - [ ] Start server
  - [ ] Call a minimal chat/research endpoint in normal mode
  - [ ] Assert stream completes and “done/terminal” marker is present
  - [ ] Assert assistant message persistence (DB/local store)
- [ ] Add a smoke test for deep research mode (at least one run) asserting:
  - [ ] Stream completes
  - [ ] Final payload contains a synthesized answer OR a controlled fallback
  - [ ] Citation normalization executed (no grouped citations left if repair path ran)

## Frontend (Production Build + Reliability)
- [ ] Validate frontend build output directory matches backend static serving:
  - [ ] Confirm frontend produces `frontend/dist/public`
  - [ ] Adjust backend static path if mismatch
- [ ] Add frontend runtime env validation:
  - [ ] Validate backend base URL
  - [ ] Validate allowed origins / SSE endpoints are reachable
- [ ] Add frontend error boundary around research rendering:
  - [ ] Ensure partial results (fallback) display cleanly

## CI/CD (Release Gates)
- [ ] Create/extend GitHub Actions (or equivalent) pipeline:
  - [ ] Backend: `npm ci` → `typecheck` → `test`
  - [ ] Backend smoke subset (at least one normal-mode generation smoke)
  - [ ] Frontend: `npm ci` → `typecheck/lint` (if available) → `build`
- [ ] Fail release if any required step or smoke test fails

## Deployment Documentation
- [ ] Add `docs/PRODUCTION.md` with:
  - [ ] Required environment variables
  - [ ] Proxy configuration notes for SSE (timeouts + buffering off)
  - [ ] Health check endpoints to monitor
