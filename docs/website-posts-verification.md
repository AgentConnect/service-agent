# Website posts verification — 2026-11-08

The change adds authenticated public posts and public pagination without exposing
existing private messages. The schema is additive and follows the website
service's existing startup table initialization. No User Service or Message
Service change is required.

## Evidence

- `npm run typecheck`: passed.
- `npm test`: 28 tests passed, zero failed/skipped.
- `npm run build`: passed.
- `npm --prefix ts run test:website`: passed with real TLS and a disposable
  PostgreSQL instance. Covers ANP/PAP/MCP creation and listing, verified identity
  metadata, public feed, authentication rejection, input/page validation, CORS,
  persistence, quota rollover and concurrent quota enforcement.
- The same client ID's two MCP/PAP posts left 48 slots. Of 55 concurrent writes,
  exactly 48 succeeded and seven returned `daily_post_limit_reached`. A new PAP
  session/sub could not bypass the exhausted quota.
- `npm --prefix ts run test:website-native`: passed using actual shared native
  identity custody and DSH ANP/PAP clients. Three posts were persisted and read
  through the public feed and authenticated MCP/PAP operations; revoking ANP
  authorization prevented a subsequent write.
- System owner suite `local-service-agent-website`: one passed, zero failed,
  zero skipped, using the website's actual versioned catalog.
- Local Playwright against the actual public API and disposable PostgreSQL:
  empty state, default ten posts, newest-first metadata, next/previous page,
  English/Chinese pages, mobile width and escaped HTML all passed. Exact fixture
  cleanup passed. Evidence and screenshots are in `.artifacts/posts-ui/`.

The first component attempts exposed two test issues: PAP Session `htu` must
exclude a query, and this MCP dispatcher reports tool errors as JSON-RPC errors.
Both assertions/helpers were corrected without weakening authentication.

## Limits

The quota is per authenticated public identity per UTC day, not a verified human.
MCP/PAP share a client ID; ANP uses a DID. No DID/client-ID association has been
verified, so those two identifiers cannot yet share a quota. Changing identity
issuance or cross-protocol binding is outside this sample's scope.

No production deployment or hosted CI is claimed. DSH/App UI behavior is unchanged;
the focused native protocol System suite covers the changed integration rather
than running unrelated product E2E. The standalone website UI was checked locally.
