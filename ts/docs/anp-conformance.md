# ANP compatibility scope and live verification

This example implements active domain discovery, Agent Description, and did:wba
HTTP request authentication with a JSON OpenAPI interface. Normative references
are the official ANP 1.2 release documents:

- [ANP-08 discovery](https://github.com/agent-network-protocol/AgentNetworkProtocol/blob/v1.2/08-ANP-Agent-Discovery-Protocol-Specification.md)
- [ANP-07 description](https://github.com/agent-network-protocol/AgentNetworkProtocol/blob/v1.2/07-anp-agent-description-protocol-specification.md)
- [ANP-02 authentication](https://github.com/agent-network-protocol/AgentNetworkProtocol/blob/v1.2/02-anp-did-authentication-protocol-specification.md)

## Checked requirements

| Area | Implemented behavior |
| --- | --- |
| Discovery entry | `/.well-known/agent-descriptions`, JSON-LD CollectionPage, `@context`, `@type`, `url`, `items`; each item has `@type`, `name`, `@id` |
| Pagination | The demo publishes one agent and omits optional `next`; the DSH client follows `next` and deduplicates descriptions when querying a paged directory |
| Agent Description | `protocolType: ANP`, `protocolVersion: 1.0.0`, `type: AgentDescription`, name, securityDefinitions and a security reference; information and interface URLs |
| Optional server identity | No server DID or document proof; both are optional in the ANP-07 field table. HTTPS authenticates the domain |
| Linked interaction | `Infomations` links the protocol catalog; `interfaces` links JSON OpenAPI 3.1 with exact-version reads and message submission |
| Request identity | Public HTTPS DID Document resolution, exact DID match, method binding and an authentication-authorized verification method |
| HTTP proof | Signature-Input and Signature; actual method and target URI covered; request bodies require signed Content-Digest; timestamps and nonce replay checks |
| Challenges | Missing/invalid proof returns 401 with DIDWba and Accept-Signature; writes request content-digest coverage |

The AD protocolVersion follows ANP-07's field table, which still specifies
`1.0.0` inside the ANP 1.2 release. It is not the server package version. The
current `Infomations` spelling likewise follows that released document.

The didwba security definition names the Signature header and explains the paired
Signature-Input and body digest requirements. It does not advertise Bearer token
issuance. OpenAPI uses header security declarations to describe those actual
headers; the authentication algorithm remains ANP-02/RFC 9421, not a static API key.

## Live deployment evidence

The independent demo is `https://anp-demo.awiki.info`. On 2026-11-08,
`node --import tsx ts/scripts/anp-live.ts` passed 13 public HTTPS checks: JSON-LD
discovery, protected description challenge, native client DID resolution,
signed AD, linked catalog and OpenAPI, exact-version Chinese protocol content,
unknown-version rejection, stored message receipt, replay rejection, changed
target/body rejection, and unsigned-write rejection. The service used its normal
production resolver and TLS validation; there was no fixture DNS or signer.
Task-owned client DID material, native private state and the exact test message
were removed after the successful run.

Unit and isolated HTTPS/PostgreSQL checks supplement this live path. Compatibility
is asserted for the implemented profile and checked requirements, not every ANP
extension or every possible peer. Passive search registration, did:web, OpenRPC,
natural-language task delegation and messaging are not advertised by this example.
