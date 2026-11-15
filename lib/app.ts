// The HTTP surface of the forge: one server, four faces.
//
//   GET  /healthz        no auth, always 200 {ok: true}
//   /api/v3/*            REST, bearer auth
//   POST /api/graphql   GraphQL, bearer auth
//   POST /mcp           MCP (JSON-RPC 2.0), bearer auth
//   /{owner}/{repo}.git/*  git smart HTTP, no auth
//   anything else       404 JSON
//
// Every reply carries a non-empty X-GitHub-Request-Id. REST, GraphQL, MCP,
// health and error replies are application/json with an error body of the
// shape {message}. A request that presents no bearer token, or the wrong
// one, is 401 JSON; a malformed JSON body on a JSON surface is 400.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest, type RestOut } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { infoRefs, receivePack, uploadPack, type GitResponse } from './githttp.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match === null ? null : match[1];
}

export function createForgeServer(): ReturnType<typeof createServer> {
  const forge = new Forge();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestCount = 0;

  function requestId(): string {
    requestCount += 1;
    return `forge-${requestCount}`;
  }

  function writeJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
    const payload = body === null ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'x-github-request-id': requestId(),
      ...extraHeaders,
    });
    res.end(payload);
  }

  function writeError(res: ServerResponse, status: number, message: string): void {
    writeJson(res, status, { message });
  }

  function writeGit(res: ServerResponse, result: GitResponse): void {
    res.writeHead(result.status, {
      'content-type': result.contentType,
      'x-github-request-id': requestId(),
    });
    res.end(result.body);
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      const method = req.method ?? 'GET';
      const origin = `http://${req.headers.host ?? '127.0.0.1'}`;

      if (method === 'GET' && path === '/healthz') {
        writeJson(res, 200, { ok: true });
        return;
      }

      const authorized = token !== '' && bearerOf(req) === token;

      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        if (!authorized) {
          writeError(res, 401, 'Bad credentials');
          return;
        }
        const body = await readBody(req);
        let parsed: unknown;
        let bodyError = false;
        if (body.length > 0) {
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            bodyError = true;
          }
        }
        const segments = path
          .slice('/api/v3'.length)
          .split('/')
          .filter((segment) => segment !== '');
        const result: RestOut = handleRest(forge, { method, segments, query: url.searchParams, body: parsed, bodyError, origin });
        if (result.status === 204) {
          res.writeHead(204, { 'x-github-request-id': requestId() });
          res.end();
          return;
        }
        writeJson(res, result.status, result.body, result.headers);
        return;
      }

      if (method === 'POST' && path === '/api/graphql') {
        if (!authorized) {
          writeError(res, 401, 'Bad credentials');
          return;
        }
        const body = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          writeError(res, 400, 'Malformed JSON');
          return;
        }
        const result = executeGraphQL(forge, parsed);
        writeJson(res, result.status, result.body);
        return;
      }

      if (method === 'POST' && path === '/mcp') {
        if (!authorized) {
          writeError(res, 401, 'Bad credentials');
          return;
        }
        const body = await readBody(req);
        const result = handleMcp(forge, body.toString('utf8'));
        if (result.status === 202 || result.body === null) {
          res.writeHead(202, { 'x-github-request-id': requestId() });
          res.end();
          return;
        }
        writeJson(res, result.status, result.body);
        return;
      }

      const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
      if (gitMatch !== null) {
        const owner = decodeURIComponent(gitMatch[1] ?? '');
        const repo = decodeURIComponent(gitMatch[2] ?? '');
        const sub = gitMatch[3] ?? '/';
        const body = await readBody(req);
        const gitReq = { method, headers: req.headers, body };
        if (sub === '/info/refs') {
          writeGit(res, infoRefs(forge, owner, repo, url.searchParams.get('service') ?? undefined, gitReq));
          return;
        }
        if (sub === '/git-upload-pack') {
          writeGit(res, uploadPack(forge, owner, repo, gitReq));
          return;
        }
        if (sub === '/git-receive-pack') {
          writeGit(res, receivePack(forge, owner, repo, gitReq));
          return;
        }
        writeError(res, 404, 'Not Found');
        return;
      }

      writeError(res, 404, 'Not Found');
    } catch (err) {
      if (!res.headersSent) {
        writeError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
      } else {
        res.destroy();
      }
    }
  });
}
