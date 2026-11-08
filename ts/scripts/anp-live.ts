/** Live HTTPS acceptance with task-owned native client DID publication and cleanup. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const load = (path: string) =>
  import(pathToFileURL(resolve(workspace, path)).href);
const { IdentityProvider } = await load(
  "anp-identity/bindings/node/provider.js",
);
const { createAuthenticatedHttp } = await load(
  "anp-identity/packages/dsh-anp-identity/src/http-auth.ts",
);
const { requestSigningKid } = await load(
  "anp-identity/packages/dsh-anp-identity/src/user-service.ts",
);
const { AnpClient } = await load("dsh-anp/src/index.ts");
const origin = "https://anp-demo.awiki.info";
const runId = "live-" + randomUUID();
const state = await mkdtemp(join(workspace, ".artifacts/anp-live-"));
const publicRun = "/var/lib/awiki-anp-demo/public/test-identities/" + runId;
const master = randomBytes(32);
const receipts: string[] = [];
const checks: string[] = [];
let provider: any,
  lease: any,
  clientDid = "";
const passed = (name: string) => {
  checks.push(name);
  process.stdout.write("PASS " + name + "\n");
};
const sql = (query: string) =>
  execFileSync(
    "sudo",
    [
      "-n",
      "runuser",
      "-u",
      "awiki_anp_pg",
      "--",
      "/usr/lib/postgresql/14/bin/psql",
      "-h",
      "/run/awiki-anp-postgres",
      "-d",
      "awiki_anp_demo",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      query,
    ],
    { encoding: "utf8" },
  ).trim();
try {
  const discoveryResponse = await fetch(
    origin + "/.well-known/agent-descriptions",
  );
  assert.equal(discoveryResponse.status, 200);
  assert.match(
    discoveryResponse.headers.get("content-type") ?? "",
    /application\/ld\+json/,
  );
  const discovery = (await discoveryResponse.json()) as any;
  assert.equal(discovery["@type"], "CollectionPage");
  assert.equal(discovery.items.length, 1);
  assert.equal(discovery.items[0]["@id"], origin + "/agents/official/ad.json");
  passed("public ANP JSON-LD discovery");
  const anonymous = await fetch(discovery.items[0]["@id"]);
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("www-authenticate") ?? "", /DIDWba/);
  assert.match(anonymous.headers.get("accept-signature") ?? "", /@target-uri/);
  passed("description requires ANP request authentication");

  provider = await IdentityProvider.initialize({
    stateRoot: join(state, "identity"),
    rootKeyKind: "injected",
    keyId: runId,
    rootKey: master,
  });
  lease = provider.acquireLease({
    consumer: "anp-live-owner",
    capabilities: [
      "IDENTITY_CREATE",
      "IDENTITY_READ",
      "IDENTITY_HTTP_SIGNATURE",
    ],
    ttlSeconds: 300,
  });
  const identity = await lease.create({
    profile: "e1",
    domain: "anp-demo.awiki.info",
    pathSegments: ["test-identities", runId],
    capabilities: { didWba: true },
    managedKeys: [
      { fragment: "root", role: "root_control" },
      { fragment: "request", role: "request_signing" },
    ],
  });
  clientDid = identity.reference.did;
  assert.match(
    clientDid,
    /^did:wba:anp-demo\.awiki\.info:test-identities:live-[a-f0-9-]+:e1_[A-Za-z0-9_-]+$/,
  );
  const relative = clientDid.split(":").slice(3).join("/") + "/did.json";
  const publicFile = "/var/lib/awiki-anp-demo/public/" + relative;
  const document = (await lease.publicIdentity(identity.reference)).document;
  const localDocument = join(state, "did.json");
  await writeFile(localDocument, JSON.stringify(document));
  execFileSync("sudo", [
    "-n",
    "install",
    "-d",
    "-m",
    "0755",
    publicFile.slice(0, publicFile.lastIndexOf("/")),
  ]);
  execFileSync("sudo", [
    "-n",
    "install",
    "-m",
    "0644",
    localDocument,
    publicFile,
  ]);
  const publicDid = await fetch(origin + "/" + relative);
  assert.equal(publicDid.status, 200);
  assert.equal(((await publicDid.json()) as any).id, clientDid);
  passed("native client DID resolves over public HTTPS");
  const active = async () => {
    await lease.publicIdentity(identity.reference);
  };
  const signed = createAuthenticatedHttp(
    identity.reference,
    lease,
    new Set([origin]),
    active,
    async () =>
      requestSigningKid(await lease.publicIdentity(identity.reference)),
  );
  const client = new AnpClient({
    allowedOrigins: [origin],
    authenticatedDispatch: (request: Request) =>
      signed.dispatch(request, (outgoing: Request) => fetch(outgoing)),
  });
  const directory = await client.discover("anp-demo.awiki.info");
  assert.equal(directory.count, 1);
  const description = await client.describe(directory.agents[0].agentRef);
  assert.equal(description.content.type, "AgentDescription");
  assert.equal(description.content.did, undefined);
  assert.equal(description.content.securityDefinitions.didwba.scheme, "didwba");
  passed("signed AgentDescription without server DID");
  const information = await client.read(
    description.links.find((link: any) => link.kind === "information")
      .resourceRef,
  );
  assert.deepEqual(information.content.versions, ["1.0", "1.1", "1.2"]);
  passed("linked information catalog and published versions");
  const api = await client.read(
    description.links.find((link: any) => link.kind === "interface")
      .resourceRef,
  );
  assert.equal(
    api.content.components.securitySchemes.anpSignatureInput.name,
    "Signature-Input",
  );
  const operation = (name: string) =>
    api.operations.find((item: any) => item.operationId === name).operationRef;
  assert.ok(operation("protocol_get"));
  assert.ok(operation("message_create"));
  passed("linked OpenAPI operations and signature metadata");
  const protocol = await client.call(operation("protocol_get"), {
    path: { version: "1.2", document: "did-authentication" },
    query: { language: "zh" },
  });
  assert.equal(protocol.content.version, "1.2");
  assert.equal(protocol.content.language, "zh");
  assert.match(protocol.content.content, /Signature-Input/);
  passed("signed exact-version Chinese protocol retrieval");
  await assert.rejects(
    client.call(operation("protocol_get"), {
      path: { version: "9.9", document: "did-authentication" },
    }),
  );
  passed("unknown version rejected");
  const marker = "ANP deployment verification " + runId;
  const receipt = await client.call(operation("message_create"), {
    body: { message: marker },
  });
  const id = String(receipt.content.id);
  assert.match(id, /^[a-f0-9-]{36}$/);
  receipts.push(id);
  assert.equal(
    sql(
      `SELECT count(*) FROM website_messages WHERE id='${id}'::uuid AND subject='${clientDid}' AND content='${marker}'`,
    ),
    "1",
  );
  passed("signed message persisted to the independent database");
  let captured!: Request;
  await signed.dispatch(
    new Request(origin + "/anp/catalog.json"),
    async (request: Request) => {
      captured = request.clone();
      const response = await fetch(request);
      assert.equal(response.status, 200);
      return response;
    },
  );
  assert.equal((await fetch(captured)).status, 401);
  passed("replayed signature rejected");
  await signed.dispatch(
    new Request(origin + "/anp/catalog.json"),
    async (request: Request) => {
      const response = await fetch(
        new Request(request.url + "?changed=1", request),
      );
      assert.equal(response.status, 401);
      return response;
    },
  );
  passed("changed target URI rejected");
  await signed.dispatch(
    new Request(origin + "/anp/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: marker }),
    }),
    async (request: Request) => {
      const response = await fetch(
        new Request(request, {
          body: JSON.stringify({ message: marker + " changed" }),
        }),
      );
      assert.equal(response.status, 401);
      return response;
    },
  );
  passed("changed request body rejected");
  const unsignedWrite = await fetch(origin + "/anp/api/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: marker }),
  });
  assert.equal(unsignedWrite.status, 401);
  assert.match(
    unsignedWrite.headers.get("accept-signature") ?? "",
    /content-digest/,
  );
  passed("unsigned writes rejected with body signature requirements");
  process.stdout.write(
    JSON.stringify({ origin, passed: checks.length, failed: 0 }) + "\n",
  );
} finally {
  for (const id of receipts) {
    assert.match(id, /^[a-f0-9-]{36}$/);
    sql(
      `DELETE FROM website_messages WHERE id='${id}'::uuid AND subject='${clientDid}' AND content='ANP deployment verification ${runId}'`,
    );
    assert.equal(
      sql(`SELECT count(*) FROM website_messages WHERE id='${id}'::uuid`),
      "0",
    );
  }
  execFileSync("sudo", ["-n", "rm", "-rf", "--", publicRun]);
  lease?.dispose();
  await provider?.dispose();
  master.fill(0);
  await rm(state, { recursive: true, force: true });
  process.stdout.write(
    "Task-owned test message, public client DID and native state cleaned\n",
  );
}
