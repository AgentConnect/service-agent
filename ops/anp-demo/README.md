# ANP public demo deployment

This fixed deployment owns only `https://anp-demo.awiki.info`, loopback port
21696, `awiki-anp-demo.service`, `awiki-anp-postgres.service`, the
`/var/lib/awiki-anp-demo` state root and `/etc/awiki-anp-demo/runtime.env`.
It uses the existing public wildcard DNS/certificate and an additional Nginx
virtual host. Existing User, MCP and PAP deployments remain separate.

Build and test the service from its current worktree, package the built runtime
with `npm pack`, and stage an extracted candidate with the matching root
`package-lock.json`, production dependencies, Node 22.13+ binary named `node`,
and the website's generated `protocol-catalog.json`. Then run:

```sh
sudo python3 ops/anp-demo/install.py --candidate /absolute/candidate --commit FULL_COMMIT
```

The installer creates dedicated users, a Unix-socket-only PostgreSQL cluster and
its own database, preserves a restore-checked pre-migration backup, installs the
immutable release and private environment, and starts only the two named units.
The runtime role owns only this example database; it has no cluster superuser,
database-creation or role-creation privilege. The application creates its own
message table on first start. There is no password or server DID for ANP.

The public discovery endpoint is `/.well-known/agent-descriptions` and returns
JSON-LD. `/agents/official/ad.json`, `/anp/catalog.json`, `/anp/openapi.json` and
`/anp/api/...` require ANP-02 HTTP Message Signatures. The description omits a
server DID, links information and OpenAPI, and describes supported authentication.
OpenAPI declares `Signature-Input`, `Signature` and the body `Content-Digest`.
The same process retains the MCP and signed-out PAP reference interfaces.

Run `node --import tsx ts/scripts/anp-live.ts` from the service worktree for live
acceptance. It uses the sibling native identity library and actual dsh-anp client,
temporarily publishes only a task-owned client DID Document under this host's
`/test-identities/`, and checks public discovery, signed linked resources, exact
protocol reads, message persistence and authentication rejection. It removes its
exact test message, public DID and private native state afterward. It never exports
client private keys or modifies shared Agent configuration.

Public readiness is `/ready`. Read deployment provenance from
`/var/lib/awiki-anp-demo/deployment.json`; the environment file is root-only.
For status use `systemctl status awiki-anp-demo awiki-anp-postgres`. Restarting only
the application leaves database contents intact. Rollback selects the recorded
previous release and restarts only `awiki-anp-demo`; remove only this new Nginx
virtual host if disabling the demo, then validate and reload Nginx. Database
backups and persistent data remain under the owned state root.
