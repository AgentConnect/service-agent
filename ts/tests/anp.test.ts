import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDidWbaDocument,
  generateHttpSignatureHeaders,
  DidProfile,
} from "@awiki/anp-typescript-sdk";
import { AnpVerifier } from "../packages/anp/index.js";
import { serviceOpenApi } from "../packages/service-agent/index.js";

const identity = createDidWbaDocument("identity.example", {
  pathSegments: ["agents", "test"],
  didProfile: DidProfile.E1,
});
const url = "https://service.example/anp/api/messages";
const body = Buffer.from('{"message":"hello"}');
const sign = (target = url, payload = body, components?: string[]) =>
  generateHttpSignatureHeaders(
    identity.didDocument,
    target,
    "POST",
    identity.keys["key-1"]!.privateKeyPem,
    {},
    payload,
    components ? { coveredComponents: components } : {},
  );
const verifier = () => new AnpVerifier(async () => identity.didDocument);

test("ANP OpenAPI advertises both signature headers and the body digest for writes", () => {
  const api = serviceOpenApi("https://service.example", "anp");
  const schemes = api.components.securitySchemes;
  assert.equal(schemes.anpSignatureInput?.name, "Signature-Input");
  assert.equal(schemes.anpSignature?.name, "Signature");
  assert.equal(schemes.anpContentDigest?.name, "Content-Digest");
  const read = api.paths["/anp/api/protocols"]!.get!;
  const write = api.paths["/anp/api/messages"]!.post!;
  assert.deepEqual(read.security, [
    { anpSignatureInput: [], anpSignature: [] },
  ]);
  assert.deepEqual(write.security, [
    { anpSignatureInput: [], anpSignature: [], anpContentDigest: [] },
  ]);
});

test("ANP authenticates an E1 client without a server DID or token key", async () => {
  assert.deepEqual(await verifier().verify("POST", url, sign(), body), {
    did: identity.didDocument.id,
  });
});
test("ANP rejects replay, body tampering and a changed target or method", async () => {
  const v = verifier(),
    headers = sign();
  await v.verify("POST", url, headers, body);
  await assert.rejects(v.verify("POST", url, headers, body));
  await assert.rejects(
    verifier().verify("POST", url, sign(), Buffer.from("{}")),
  );
  await assert.rejects(
    verifier().verify("POST", url + "?changed=1", sign(), body),
  );
  await assert.rejects(verifier().verify("PUT", url, sign(), body));
});
test("ANP rejects missing coverage, wrong DID resolution and bearer substitution", async () => {
  await assert.rejects(
    verifier().verify("POST", url, sign(url, body, ["@authority"]), body),
  );
  const wrong = new AnpVerifier(async () => ({
    ...identity.didDocument,
    id: "did:wba:other.example",
  }));
  await assert.rejects(wrong.verify("POST", url, sign(), body));
  await assert.rejects(
    verifier().verify(
      "POST",
      url,
      { ...sign(), Authorization: "Bearer arbitrary" },
      body,
    ),
  );
});
