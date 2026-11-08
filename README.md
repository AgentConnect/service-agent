# Service Agent

本仓库已更名为 `AgentConnect/service-agent`。新增 ANP 身份认证模块与 ANP、MCP、PAP 三协议组合入口，复用一份版本文档读取和留言业务。ANP 服务端不需要自己的 DID；接入、配置与验证见 [三协议服务说明](ts/docs/service-agent.md)。原有 CIMD 机器 OAuth 和 PAP 示例继续保留。

本仓库以 [Apache-2.0](LICENSE) 开源，包含 CIMD `private_key_jwt` + `client_credentials` 授权服务器、PostgreSQL 存储、可独立运行的资源验证组件和两个只读工具的 MCP 应用。当前全部实现与工具链位于 [`ts/`](ts/)；Rust 留待后续阶段。

另提供 [PAP 0.3 无人交互 hello demo](ts/docs/pap-demo.md)：通过公共身份验证 PAP Session 后调用 OpenAPI，无需浏览器或账户授权。

从 [`ts/docs/quickstart.md`](ts/docs/quickstart.md) 开始。协议契约、安全边界、依赖来源及本次实际验证见 [`docs/protocol.md`](docs/protocol.md)、[`docs/security.md`](docs/security.md)、[`docs/sources.md`](docs/sources.md) 和 [`ts/docs/verification.md`](ts/docs/verification.md)。

MCP 机器模式下，未知客户端只有通过运营者显式配置的有界 `open_basic` 政策后才能取得有限机器权限。公开 CIMD、签名正确与资源授权是独立步骤。独立 PAP demo 只提供 signed-out Session；本仓库不提供浏览器授权、用户账户、授权码、Refresh Token、DCR 或 Agent 私钥托管/代签。

源码公开；npm 包和镜像发布另行安排，当前不执行制品发布。

## Public website posts

The shared website service exposes `post_create` and `post_list` for ANP, MCP and
PAP, alongside the existing protocol-document and private-message operations.
Post content must contain 1–1,024 Unicode characters.
Publish `{ "content": "Hello ANP" }` through `POST /anp/api/posts`,
`POST /pap/api/posts`, or the MCP `post_create` tool (`message.write`). Read with
`GET /anp/api/posts?page=1`, `GET /pap/api/posts?page=1`, or `post_list`
(`protocol.read`). Publishing requires the existing protocol authentication.
The public read-only `/api/posts?page=1` feed returns 10 posts per page, newest
first, including verified `identity`, `protocol`, `createdAt` and plain-text
`content`. Old private messages are excluded.

PostgreSQL persists posts and atomically enforces 50 posts per public identity per
UTC day. MCP/PAP use the same public client ID for their shared quota; PAP Session
IDs and pairwise subjects cannot reset it. ANP uses the verified DID; a verified
DID-to-client-ID association is not currently available. Exceeding the allowance
returns `daily_post_limit_reached`. Restarting the process preserves the quota.
`WEBSITE_ORIGIN` permits that site's browser to read the public feed across origins.

Run `npm --prefix ts run test:website` for real TLS/PostgreSQL protocol, pagination,
concurrency and quota coverage, and `npm --prefix ts run test:website-native` for
actual shared native-identity clients. Both use isolated disposable databases.
