import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { fail } from "../oauth-core/errors.js";
import type { Caller, ProtocolServices } from "./index.js";

export interface ProtocolDocument {
  version: string;
  language: string;
  document: string;
  content: string;
  sourceUrl: string;
}
/** Build once from the website's versioned Markdown, never from the network. */
export async function buildProtocolCatalog(
  docsRoot: string,
  origin: string,
): Promise<ProtocolDocument[]> {
  const catalog: ProtocolDocument[] = [];
  const visit = async (
    directory: string,
    prefix: string,
    version: string,
    language: string,
  ) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relative = prefix + entry.name;
      if (entry.isDirectory())
        await visit(path, relative + "/", version, language);
      else if (entry.isFile() && entry.name.endsWith(".md"))
        catalog.push({
          version,
          language,
          document: relative.slice(0, -3),
          content: await readFile(path, "utf8"),
          sourceUrl: `${origin}/${language === "zh" ? "zh/" : ""}specs/${version}/${relative.slice(0, -3)}`,
        });
    }
  };
  for (const language of ["en", "zh"]) {
    const root = join(docsRoot, language === "zh" ? "zh/specs" : "specs");
    for (const version of ["1.0", "1.1", "1.2"]) {
      try {
        await visit(join(root, version), "", version, language);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  if (!catalog.length) fail("empty_protocol_catalog", 500);
  return catalog.sort((a, b) =>
    `${a.version}/${a.language}/${a.document}`.localeCompare(
      `${b.version}/${b.language}/${b.document}`,
    ),
  );
}
export async function createWebsiteServices(
  catalog: readonly ProtocolDocument[],
  pool: Pool,
): Promise<ProtocolServices> {
  await pool.query(`CREATE TABLE IF NOT EXISTS website_messages (
    id uuid PRIMARY KEY, protocol text NOT NULL, subject text NOT NULL,
    content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS website_posts (
    id uuid PRIMARY KEY, protocol text NOT NULL, subject text NOT NULL,
    content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS website_posts_latest
    ON website_posts (created_at DESC, id DESC)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS website_post_daily_counts (
    subject text NOT NULL, day date NOT NULL, count integer NOT NULL,
    PRIMARY KEY (subject, day), CHECK (count BETWEEN 1 AND 50)
  )`);
  const language = (args: Record<string, unknown>) =>
    String(args.language ?? "en");
  return {
    async createPost(args, caller) {
      if (
        typeof args.content !== "string" ||
        !args.content.trim() ||
        args.content.length > 4000
      )
        fail("invalid_arguments");
      const identity = caller.publicIdentity ?? caller.subject;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // The upsert locks this identity/day even across concurrent workers.
        const quota = await client.query(
          `INSERT INTO website_post_daily_counts (subject, day, count)
          VALUES ($1, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date, 1)
          ON CONFLICT (subject, day) DO UPDATE SET count = website_post_daily_counts.count + 1
          WHERE website_post_daily_counts.count < 50 RETURNING count`,
          [identity],
        );
        if (!quota.rowCount) fail("daily_post_limit_reached", 429);
        const result = await client.query(
          `INSERT INTO website_posts (id, protocol, subject, content)
           VALUES ($1, $2, $3, $4)
           RETURNING id, protocol, subject AS identity, content, created_at AS "createdAt"`,
          [
            randomUUID(),
            caller.protocol,
            identity,
            String(args.content).trim(),
          ],
        );
        await client.query("COMMIT");
        return result.rows[0];
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async listPosts(args) {
      const page = args.page ?? 1;
      if (
        typeof page !== "number" ||
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > 1000000
      )
        fail("invalid_arguments");
      const result = await pool.query(
        `SELECT
        (SELECT count(*)::int FROM website_posts) AS total,
        COALESCE((SELECT jsonb_agg(post ORDER BY post."createdAt" DESC, post.id DESC) FROM (
          SELECT id, protocol, subject AS identity, content, created_at AS "createdAt"
          FROM website_posts ORDER BY created_at DESC, id DESC LIMIT 10 OFFSET $1
        ) post), '[]'::jsonb) AS posts`,
        [(Number(page) - 1) * 10],
      );
      return {
        ...result.rows[0],
        page,
        pageSize: 10,
        dailyLimit: 50,
        dayTimezone: "UTC",
      };
    },
    async listProtocols(args) {
      const documents = catalog.filter(
        (doc) =>
          (!args.version || doc.version === args.version) &&
          doc.language === language(args),
      );
      if (!documents.length) fail("protocol_not_found", 404);
      return {
        versions: [...new Set(documents.map((doc) => doc.version))],
        language: language(args),
        documents: documents.map(({ content: _content, ...doc }) => doc),
      };
    },
    async getProtocol(args) {
      const doc = catalog.find(
        (doc) =>
          doc.version === args.version &&
          doc.document === args.document &&
          doc.language === language(args),
      );
      if (!doc) fail("protocol_not_found", 404);
      return { ...doc, contentType: "text/markdown" };
    },
    async createMessage(args, caller: Caller) {
      if (
        typeof args.message !== "string" ||
        !args.message.trim() ||
        args.message.length > 4000
      )
        fail("invalid_arguments");
      const id = randomUUID();
      const result = await pool.query<{ created_at: Date }>(
        "INSERT INTO website_messages (id, protocol, subject, content) VALUES ($1, $2, $3, $4) RETURNING created_at",
        [id, caller.protocol, caller.subject, args.message],
      );
      return { id, createdAt: result.rows[0]!.created_at.toISOString() };
    },
  };
}
