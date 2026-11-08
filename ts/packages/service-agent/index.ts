import express, { type ErrorRequestHandler } from "express";
import type { Express } from "express";
import { AnpVerifier } from "../anp/index.js";
import { PapSessionVerifier } from "../pap/session.js";
import { TokenVerifier } from "../oauth-rs/index.js";
import {
  createMcpApp,
  type McpTool,
} from "../../examples/minimal-mcp-server/app.js";
import { fail, ProtocolError } from "../oauth-core/errors.js";
import { httpsUrl } from "../oauth-core/parse.js";

export { AnpVerifier, publicDidResolver } from "../anp/index.js";

export interface Caller {
  protocol: "anp" | "mcp" | "pap";
  subject: string;
  publicIdentity?: string;
}
export interface ProtocolServices {
  listProtocols(args: Record<string, unknown>): Promise<unknown>;
  getProtocol(args: Record<string, unknown>): Promise<unknown>;
  createMessage(
    args: Record<string, unknown>,
    caller: Caller,
  ): Promise<unknown>;
  createPost(args: Record<string, unknown>, caller: Caller): Promise<unknown>;
  listPosts(args: Record<string, unknown>): Promise<unknown>;
}
const string = { type: "string" };
const definitions = [
  {
    name: "protocol_list",
    method: "get",
    path: "/protocols",
    description: "List published protocol versions and documents",
    scope: "protocol.read",
    properties: { version: string, language: string },
    required: [] as string[],
  },
  {
    name: "protocol_get",
    method: "get",
    path: "/protocols/{version}/{document}",
    description: "Read a specific version of a protocol document",
    scope: "protocol.read",
    properties: { version: string, document: string, language: string },
    required: ["version", "document"],
  },
  {
    name: "message_create",
    method: "post",
    path: "/messages",
    description: "Leave a text message for the website",
    scope: "message.write",
    properties: { message: { type: "string", minLength: 1, maxLength: 4000 } },
    required: ["message"],
  },
  {
    name: "post_create",
    method: "post",
    path: "/posts",
    description:
      "Publish a public plain-text post as the authenticated identity (50 per UTC day)",
    scope: "message.write",
    properties: { content: { type: "string", minLength: 1, maxLength: 4000 } },
    required: ["content"],
  },
  {
    name: "post_list",
    method: "get",
    path: "/posts",
    description:
      "Read latest public posts, newest first, with identity, protocol and timestamp",
    scope: "protocol.read",
    properties: { page: { type: "integer", minimum: 1, maximum: 1000000 } },
    required: [] as string[],
  },
] as const;
const postListDefinition = definitions.find(
  (definition) => definition.name === "post_list",
)!;
function argumentsFor(
  definition: (typeof definitions)[number],
  value: unknown,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("invalid_arguments");
  const args = value as Record<string, unknown>;
  if (definition.name === "post_list") {
    if (Object.keys(args).some((key) => key !== "page"))
      fail("invalid_arguments");
    const page = args.page ?? 1;
    if (
      (typeof page !== "number" && typeof page !== "string") ||
      !/^[1-9][0-9]*$/.test(String(page)) ||
      Number(page) > 1000000
    )
      fail("invalid_arguments");
    return { page: Number(page) };
  }
  if (
    Object.keys(args).some((key) => !(key in definition.properties)) ||
    definition.required.some(
      (key) => typeof args[key] !== "string" || !args[key],
    ) ||
    Object.values(args).some((value) => typeof value !== "string")
  )
    fail("invalid_arguments");
  if (
    definition.name === "message_create" &&
    (String(args.message).length > 4000 || !String(args.message).trim())
  )
    fail("invalid_arguments");
  return args;
}
export function serviceOpenApi(origin: string, protocol: "anp" | "pap") {
  return {
    openapi: "3.1.0",
    info: { title: "Service Agent", version: "0.1.0" },
    servers: [{ url: origin }],
    components: {
      securitySchemes:
        protocol === "anp"
          ? {
              anpSignatureInput: {
                type: "apiKey",
                in: "header",
                name: "Signature-Input",
                description:
                  "ANP-02 RFC 9421 signature parameters with a did:wba authentication keyid, created, expires and a fresh nonce.",
              },
              anpSignature: {
                type: "apiKey",
                in: "header",
                name: "Signature",
                description:
                  "Generated per request by the ANP client's local DID signer; covers the actual method, target URI and body digest when present.",
              },
              anpContentDigest: {
                type: "apiKey",
                in: "header",
                name: "Content-Digest",
                description:
                  "RFC 9530 SHA-256 digest of the request body, included in the signed components.",
              },
            }
          : {
              poppySession: {
                type: "apiKey",
                in: "header",
                name: "Poppy-Session",
                description:
                  "PAP 0.3 signed-out Session proof generated for this request.",
              },
            },
    },
    paths: definitions.reduce<
      Record<
        string,
        Record<string, { security: unknown; [key: string]: unknown }>
      >
    >((paths, definition) => {
      const path = `/${protocol}/api${definition.path}`;
      paths[path] = {
        ...paths[path],
        [definition.method]: {
          operationId: definition.name,
          description: definition.description,
          security:
            protocol === "anp"
              ? [
                  {
                    anpSignatureInput: [],
                    anpSignature: [],
                    ...(definition.method === "post"
                      ? { anpContentDigest: [] }
                      : {}),
                  },
                ]
              : [{ poppySession: [] }],
          ...(definition.method === "post"
            ? {
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: definition.properties,
                        required: definition.required,
                        additionalProperties: false,
                      },
                    },
                  },
                },
              }
            : {
                parameters: Object.entries(definition.properties).map(
                  ([name, schema]) => ({
                    name,
                    in: definition.path.includes(`{${name}}`)
                      ? "path"
                      : "query",
                    required: definition.required.some(
                      (value) => value === name,
                    ),
                    schema,
                  }),
                ),
              }),
          responses: {
            "200": {
              description: "Operation completed",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      };
      return paths;
    }, {}),
  };
}
export function createServiceAgent(options: {
  origin: string;
  services: ProtocolServices;
  anp: AnpVerifier;
  pap: PapSessionVerifier;
  mcp: TokenVerifier;
  authorizationServer?: Express;
  websiteOrigin?: string;
}) {
  const { origin, services } = options;
  if (
    httpsUrl(origin).origin !== origin ||
    options.pap.company !== origin ||
    options.mcp.config.resource !== origin + "/mcp"
  )
    fail("invalid_service_configuration");
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(
    ["/anp", "/agents/official/ad.json"],
    express.raw({ type: () => true, limit: "16kb", inflate: false }),
  );
  const invoke = async (
    definition: (typeof definitions)[number],
    input: unknown,
    caller: Caller,
  ) => {
    const args = argumentsFor(definition, input);
    if (definition.name === "protocol_list")
      return services.listProtocols(args);
    if (definition.name === "protocol_get") return services.getProtocol(args);
    if (definition.name === "post_create")
      return services.createPost(args, caller);
    if (definition.name === "post_list") return services.listPosts(args);
    return services.createMessage(args, caller);
  };
  // The website feed is public; publishing always uses protocol authentication.
  app.get("/api/posts", async (req, res) => {
    if (options.websiteOrigin && req.get("origin") === options.websiteOrigin) {
      res.set("Access-Control-Allow-Origin", options.websiteOrigin);
    }
    res.vary("Origin");
    res.set("Cache-Control", "no-store");
    res.json(
      await services.listPosts(argumentsFor(postListDefinition, req.query)),
    );
  });
  app.get("/.well-known/agent-descriptions", (_req, res) =>
    res.type("application/ld+json").json({
      "@context": {
        "@vocab": "https://schema.org/",
        did: "https://w3id.org/did#",
        ad: "https://agent-network-protocol.com/ad#",
      },
      "@type": "CollectionPage",
      url: origin + "/.well-known/agent-descriptions",
      items: [
        {
          "@type": "ad:AgentDescription",
          name: "ANP Official Website",
          "@id": origin + "/agents/official/ad.json",
        },
      ],
    }),
  );
  app.get("/.well-known/poppy.json", (_req, res) =>
    res.json({
      protocol_version: "0.3",
      organization: {
        name: "ANP Official Website",
        domain: new URL(origin).host,
      },
      apis: [{ type: "openapi", url: origin + "/pap/openapi.json" }],
    }),
  );
  app.get("/pap/openapi.json", (_req, res) =>
    res.json(serviceOpenApi(origin, "pap")),
  );
  const authenticate = async (
    req: express.Request,
    protocol: "anp" | "pap",
  ): Promise<Caller> => {
    if (req.headers.host !== new URL(origin).host) fail("invalid_host", 400);
    const names = req.rawHeaders
      .filter((_, index) => index % 2 === 0)
      .map((value) => value.toLowerCase());
    for (const name of [
      "signature",
      "signature-input",
      "content-digest",
      "poppy-session",
      "authorization",
    ])
      if (names.filter((value) => value === name).length > 1)
        fail("invalid_authentication", 401);
    if (protocol === "anp") {
      const headers = Object.fromEntries(
        Object.entries(req.headers).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
      const result = await options.anp.verify(
        req.method,
        origin + req.originalUrl,
        headers,
        Buffer.isBuffer(req.body) ? req.body : undefined,
      );
      return { protocol, subject: result.did };
    }
    if (req.headers.authorization) fail("invalid_session");
    const result = await options.pap.verify(
      req.get("poppy-session") ?? "",
      req.method,
      origin + req.originalUrl,
    );
    // The public client identity owns the quota, not a freely chosen Session sub.
    return {
      protocol,
      subject: result.clientId + ":" + result.sub,
      publicIdentity: result.clientId,
    };
  };
  app.get("/agents/official/ad.json", async (req, res) => {
    await authenticate(req, "anp");
    res.json({
      protocolType: "ANP",
      protocolVersion: "1.0.0",
      type: "AgentDescription",
      name: "ANP Official Website",
      url: origin + "/agents/official/ad.json",
      description:
        "Read ANP specifications, publish public posts and read the latest posts.",
      securityDefinitions: {
        didwba: {
          scheme: "didwba",
          in: "header",
          name: "Signature",
          description:
            "ANP-02 HTTP Message Signatures using did:wba. Send Signature-Input and Signature; requests with a body also require a signed Content-Digest. Each request uses a fresh nonce.",
        },
      },
      security: "didwba",
      Infomations: [
        {
          type: "Information",
          description: "Published protocol versions and documents",
          url: origin + "/anp/catalog.json",
        },
      ],
      interfaces: [
        {
          type: "StructuredInterface",
          protocol: "OpenAPI",
          version: "3.1.0",
          description:
            "Read exact published protocol versions and submit a text message using ANP-authenticated HTTP requests.",
          url: origin + "/anp/openapi.json",
        },
      ],
    });
  });
  app.get("/anp/openapi.json", async (req, res) => {
    await authenticate(req, "anp");
    res.json(serviceOpenApi(origin, "anp"));
  });
  app.get("/anp/catalog.json", async (req, res) => {
    await authenticate(req, "anp");
    res.json(await services.listProtocols({}));
  });
  for (const protocol of ["anp", "pap"] as const) {
    for (const definition of definitions) {
      const path = `/${protocol}/api${definition.path.replace(/\{([^}]+)\}/g, ":$1")}`;
      app[definition.method](
        path,
        express.raw({ type: "application/json", limit: "16kb" }),
        async (req, res) => {
          const caller = await authenticate(req, protocol);
          const args =
            definition.method === "post"
              ? JSON.parse(
                  Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "{}",
                )
              : { ...req.query, ...req.params };
          res.json(await invoke(definition, args, caller));
        },
      );
    }
  }
  const tools: Record<string, McpTool> = Object.fromEntries(
    definitions.map((definition) => [
      definition.name,
      {
        description: definition.description,
        scope: definition.scope,
        readOnly: definition.method === "get",
        inputSchema: {
          type: "object",
          properties: definition.properties,
          required: [...definition.required],
          additionalProperties: false,
        },
        execute: (args, principal) =>
          invoke(definition, args, {
            protocol: "mcp",
            subject: principal.clientId,
          }),
      } satisfies McpTool,
    ]),
  );
  app.use(createMcpApp(options.mcp, tools));
  if (options.authorizationServer) app.use(options.authorizationServer);
  app.use(((error, req, res, _next) => {
    const e =
      error instanceof ProtocolError
        ? error
        : new ProtocolError(
            error instanceof SyntaxError ? "invalid_arguments" : "server_error",
            error instanceof SyntaxError ? 400 : 500,
          );
    if (
      (e.status === 401 && req.path.startsWith("/anp/")) ||
      (e.status === 401 && req.path === "/agents/official/ad.json")
    ) {
      res.set(
        "WWW-Authenticate",
        `DIDWba realm="${new URL(origin).host}", error="invalid_signature"`,
      );
      const components = [
        "@method",
        "@target-uri",
        ...(Buffer.isBuffer(req.body) ? ["content-digest"] : []),
      ];
      res.set(
        "Accept-Signature",
        `sig1=(${components.map((value) => `"${value}"`).join(" ")});created;expires;nonce;keyid`,
      );
    }
    res.status(e.status).json({ error: e.code });
  }) satisfies ErrorRequestHandler);
  return app;
}
