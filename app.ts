// app.ts — Central HTTP server for github-core-clone-01.
// Routes incoming requests across Git Smart HTTP, REST v3, GraphQL v4, and MCP.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { handleRestRequest } from './src/rest.ts';
import { handleGitInfoRefs, handleGitUploadPack, handleGitReceivePack } from './src/git.ts';
import { handleGraphQLRequest } from './src/graphql.ts';
import { handleMcpRequest } from './src/mcp.ts';
import { VIEWER } from './src/store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let reqCounter = 0;

/** Generate fast non-empty request id for X-GitHub-Request-Id header. */
export function generateRequestId(): string {
  reqCounter = (reqCounter + 1) | 0;
  return reqCounter.toString(16).padStart(16, '0');
}

/** Respond with application/json. Uses cached Buffer if available. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const buf = (typeof body === 'object' && body !== null && (body as { _jsonBuf?: Buffer })._jsonBuf)
    ? (body as { _jsonBuf: Buffer })._jsonBuf
    : Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  const reqId = generateRequestId();
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': buf.length,
    'x-github-request-id': reqId,
    ...extraHeaders,
  });
  res.end(buf);
}

/** Parse path and searchParams safely and quickly from IncomingMessage. */
export function parseUrl(req: IncomingMessage): { pathname: string; searchParams: URLSearchParams } {
  const url = req.url ?? '/';
  const qIdx = url.indexOf('?');
  if (qIdx === -1) {
    return { pathname: url, searchParams: new URLSearchParams() };
  }
  return {
    pathname: url.slice(0, qIdx),
    searchParams: new URLSearchParams(url.slice(qIdx + 1)),
  };
}

/** Check Bearer token authentication against MAKEFUN_SHOP_TOKEN. */
export function isAuthorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (!expected) return true; // If no shop token is set, allow
  const auth = req.headers.authorization ?? '';
  return auth === `Bearer ${expected}`;
}

/** Read full request body as Buffer using fast event stream. */
export function readBodyBuffer(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/** Read request body as parsed JSON using direct utf8 stream. Returns parsed object, or throws Error if invalid. */
export function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      text += chunk;
    });
    req.on('end', () => {
      const trimmed = text.trim();
      if (!trimmed) return resolve({} as T);
      try {
        resolve(JSON.parse(trimmed) as T);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/** Build and configure HTTP server. */
export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const { pathname, searchParams } = parseUrl(req);
    const method = req.method ?? 'GET';

    // 1. Healthz probe (used by harness/env boot check twice)
    if (method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Git Smart HTTP Surface: /{owner}/{repo}.git/...
    if (!pathname.startsWith('/api/') && !pathname.startsWith('/mcp')) {
      let action = '';
      let repoPart = '';
      if (pathname.endsWith('/info/refs')) {
        action = 'info/refs';
        repoPart = pathname.slice(1, -10);
      } else if (pathname.endsWith('/git-upload-pack')) {
        action = 'git-upload-pack';
        repoPart = pathname.slice(1, -16);
      } else if (pathname.endsWith('/git-receive-pack')) {
        action = 'git-receive-pack';
        repoPart = pathname.slice(1, -17);
      }
      if (action) {
        if (repoPart.endsWith('.git')) repoPart = repoPart.slice(0, -4);
        const slash = repoPart.indexOf('/');
        if (slash !== -1) {
          const owner = repoPart.slice(0, slash);
          const repoName = repoPart.slice(slash + 1);
          try {
            if (action === 'info/refs' && method === 'GET') {
              await handleGitInfoRefs(req, res, owner, repoName, searchParams);
              return;
            }
            if (action === 'git-upload-pack' && method === 'POST') {
              const body = await readBodyBuffer(req);
              await handleGitUploadPack(req, res, owner, repoName, body);
              return;
            }
            if (action === 'git-receive-pack' && method === 'POST') {
              const body = await readBodyBuffer(req);
              await handleGitReceivePack(req, res, owner, repoName, body);
              return;
            }
          } catch {
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('Internal Server Error\n');
            return;
          }
        }
      }
    }

    // 2. REST API v3 root
    if (method === 'GET' && (pathname === '/api/v3' || pathname === '/api/v3/')) {
      sendJson(
        res,
        200,
        {
          current_user_url: '/api/v3/user',
          current_user_authorizations_html_url: '/api/v3/authorizations',
          authorizations_url: '/api/v3/authorizations',
          code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
          commit_search_url: '/api/v3/search/commits?q={query}{&page,per_page,sort,order}',
          emails_url: '/api/v3/user/emails',
          emojis_url: '/api/v3/emojis',
          events_url: '/api/v3/events',
          feeds_url: '/api/v3/feeds',
          followers_url: '/api/v3/user/followers',
          following_url: '/api/v3/user/following{/target}',
          gists_url: '/api/v3/gists{/gist_id}',
          hub_url: '/api/v3/hub',
          issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
          issues_url: '/api/v3/issues',
          keys_url: '/api/v3/user/keys',
          label_search_url: '/api/v3/search/labels?q={query}&repository_id={repository_id}{&page,per_page}',
          notifications_url: '/api/v3/notifications',
          organization_url: '/api/v3/orgs/{org}',
          organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
          organization_teams_url: '/api/v3/orgs/{org}/teams',
          public_gists_url: '/api/v3/gists/public',
          rate_limit_url: '/api/v3/rate_limit',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
          current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
          starred_url: '/api/v3/user/starred{/owner}{/repo}',
          starred_gists_url: '/api/v3/gists/starred',
          topic_search_url: '/api/v3/search/topics?q={query}{&page,per_page}',
          user_url: '/api/v3/users/{user}',
          user_organizations_url: '/api/v3/user/orgs',
          user_repositories_url: '/api/v3/users/{user}/repos{?type,page,per_page,sort}',
          user_search_url: '/api/v3/search/users?q={query}{&page,per_page,sort,order}',
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }

    // 3. REST Meta
    if (method === 'GET' && pathname === '/api/v3/meta') {
      sendJson(res, 200, {
        verifiable_password_authentication: false,
        installed_version: '1.0.0',
        packages: true,
      });
      return;
    }

    // Check token authentication for protected endpoints
    if (pathname.startsWith('/api/') || pathname === '/mcp') {
      if (!isAuthorized(req)) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return;
      }
    }

    // 4. GraphQL v4 Endpoint
    if (method === 'POST' && pathname === '/api/graphql') {
      const body = await readJsonBody(req);
      await handleGraphQLRequest(req, res, body);
      return;
    }

    // 5. MCP (Model Context Protocol) Endpoint: /mcp
    if (pathname === '/mcp') {
      if (method === 'DELETE') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (method === 'POST') {
        await handleMcpRequest(req, res);
        return;
      }
    }

    // 4. REST Current Authenticated User
    if (method === 'GET' && pathname === '/api/v3/user') {
      sendJson(res, 200, VIEWER);
      return;
    }

    // 5. REST API v3 Handlers
    if (pathname.startsWith('/api/v3/')) {
      const handled = await handleRestRequest(req, res, pathname, searchParams);
      if (handled) return;
    }

    // Default 404 JSON for unhandled routes
    sendJson(res, 404, { message: 'Not Found' });
  });
}
