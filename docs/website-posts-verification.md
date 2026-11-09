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

## Length limit update

Public post content is limited to 1–1,024 Unicode code points; the old private
message limit is unchanged. The component case accepts one character and 1,024
Chinese/emoji characters through ANP/PAP/MCP and rejects 1,025 characters. API
input schemas advertise the same 1,024 maximum.

## Public protocol parity recheck — 2026-11-09

The official HTTPS deployment advertises both PAP GET and POST `/pap/api/posts`.
The MCP authorization/resource metadata advertises `protocol.read` and
`message.write`. With a read-only token, `tools/list` returns exactly
`protocol_list`, `protocol_get`, `post_list`; with both scopes it also returns
`post_create` and `message_create`. The component regression now covers both
lists and rejects a read-only `post_create` with HTTP 403.

Fresh public HTTPS checks passed: a temporary resolvable identity published one
post through each of ANP, PAP NoAS and MCP, and each protocol listed all three
posts from the same store. All task-owned posts, quota rows, temporary OAuth
client/token/material rows and public test keys were removed; audit retained.
Existing users' posts were untouched. Evidence is in
`.artifacts/protocol-parity-20261109/result.json` (12 checks, cleanup included).

NoAS does not imply GET-only and does not require account login for a website
post. PAP Agent tools expose only explicitly enabled operations; its management
UI exposes the full discovered catalog. Refresh discovery if an old catalog is
cached, then allow the POST operation on the selected no-account connection.

For MCP, both the identity policy scope ceiling and connection requested scopes
must allow `message.write`; reconnect through the normal lifecycle to acquire a
matching token. An empty MCP resources list says nothing about tool write access.
For ANP, the identity manager defaults to one-time approval; an explicit permanent
approval can authorize the configured HTTP origin until revoked. The backend
never requires a separate identity-manager approval for every post.

This recheck does not modify the user's personal client/profile configuration;
its address/profile path was not supplied. Production authentication, scope checks
and explicit operation grants remain enforced. No backend deployment was needed.
