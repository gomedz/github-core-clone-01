// src/rest.ts — REST API v3 Router and Handlers for github-core-clone-01.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, readJsonBody } from '../app.ts';
import { store, VIEWER } from './store.ts';

export async function handleRestRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  // 1. GET /api/v3/user/repos (Paginated list of repositories for viewer)
  if (method === 'GET' && (pathname === '/api/v3/user/repos' || pathname === '/api/v3/user/repos/')) {
    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));
    const perPage = Math.max(1, Math.min(100, parseInt(searchParams.get('per_page') ?? '30', 10)));

    const allRepos = store.listUserRepos(VIEWER.login);
    const start = (page - 1) * perPage;
    const pageItems = allRepos.slice(start, start + perPage);

    // If there are more pages, construct Link rel="next"
    if (allRepos.length > start + perPage) {
      const host = req.headers.host || 'entry';
      const nextUrl = new URL(req.url ?? pathname, `http://${host}`);
      nextUrl.pathname = '/api/v3/user/repos';
      nextUrl.searchParams.set('per_page', String(perPage));
      nextUrl.searchParams.set('page', String(page + 1));
      res.setHeader('link', `<${nextUrl.toString()}>; rel="next"`);
    }

    sendJson(res, 200, pageItems);
    return true;
  }

  // 2. POST /api/v3/user/repos (Create repository)
  if (method === 'POST' && (pathname === '/api/v3/user/repos' || pathname === '/api/v3/user/repos/')) {
    let body: { name?: string; private?: boolean; description?: string | null };
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return true;
    }

    if (!body.name || typeof body.name !== 'string') {
      sendJson(res, 422, { message: 'Repository name is required' });
      return true;
    }

    try {
      const repo = store.createRepo(VIEWER, body.name, body.private ?? true, body.description ?? null);
      sendJson(res, 201, repo);
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number })?.statusCode ?? 422;
      sendJson(res, statusCode, { message: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  // 3. /api/v3/repos/{owner}/{repo}/...
  if (!pathname.startsWith('/api/v3/repos/')) return false;

  const restPath = pathname.slice(14);
  const slash1 = restPath.indexOf('/');
  if (slash1 === -1) return false;

  const owner = restPath.slice(0, slash1);
  const slash2 = restPath.indexOf('/', slash1 + 1);
  const repoName = slash2 === -1 ? restPath.slice(slash1 + 1) : restPath.slice(slash1 + 1, slash2);
  const subPath = slash2 === -1 ? '' : restPath.slice(slash2 + 1);

  // Cross-owner access rule: Accessing repository under another owner returns 404, never 403
  if (owner.toLowerCase() !== VIEWER.login.toLowerCase()) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  // HOT PATH: Issues routes /api/v3/repos/{owner}/{repo}/issues...
  if (subPath.startsWith('issues')) {
    // 1. Single Issue & Issue Comments: issues/{number}...
    if (subPath.startsWith('issues/')) {
      const restIssue = subPath.slice(7);
      const slash = restIssue.indexOf('/');
      if (slash === -1 && /^\d+$/.test(restIssue)) {
        const num = parseInt(restIssue, 10);
        if (method === 'GET') {
          const issue = store.getIssue(repo, num);
          if (!issue) {
            sendJson(res, 404, { message: 'Not Found' });
            return true;
          }
          sendJson(res, 200, issue);
          return true;
        }
        if (method === 'PATCH') {
          let body: { title?: string; body?: string; state?: 'open' | 'closed' };
          try {
            body = await readJsonBody(req);
          } catch {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
            return true;
          }
          try {
            const patched = store.patchIssue(repo, num, body);
            sendJson(res, 200, patched);
          } catch (err: unknown) {
            const statusCode = (err as { statusCode?: number })?.statusCode ?? 404;
            sendJson(res, statusCode, { message: err instanceof Error ? err.message : String(err) });
          }
          return true;
        }
      } else if (slash !== -1 && restIssue.slice(slash + 1) === 'comments') {
        const numStr = restIssue.slice(0, slash);
        if (/^\d+$/.test(numStr)) {
          const num = parseInt(numStr, 10);
          if (method === 'POST') {
            let body: { body?: string };
            try {
              body = await readJsonBody(req);
            } catch {
              sendJson(res, 400, { message: 'Problems parsing JSON' });
              return true;
            }
            if (!body.body) {
              sendJson(res, 422, { message: 'Body is required' });
              return true;
            }
            try {
              const comment = store.addComment(repo, VIEWER, num, body.body);
              sendJson(res, 201, comment);
            } catch (err: unknown) {
              const statusCode = (err as { statusCode?: number })?.statusCode ?? 404;
              sendJson(res, statusCode, { message: err instanceof Error ? err.message : String(err) });
            }
            return true;
          }
          if (method === 'GET') {
            const comments = store.listComments(repo, num);
            sendJson(res, 200, comments);
            return true;
          }
        }
      }
    }

    // 2. Issues List & Create: issues
    if (subPath === 'issues') {
      if (method === 'POST') {
        let body: { title?: string; body?: string; labels?: string[] };
        try {
          body = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return true;
        }
        if (!body.title) {
          sendJson(res, 422, { message: 'Title is required' });
          return true;
        }
        try {
          const issue = store.createIssue(repo, VIEWER, body.title, body.body ?? '', body.labels ?? []);
          sendJson(res, 201, issue);
        } catch (err: unknown) {
          const statusCode = (err as { statusCode?: number })?.statusCode ?? 422;
          sendJson(res, statusCode, { message: err instanceof Error ? err.message : String(err) });
        }
        return true;
      }
      if (method === 'GET') {
        const stateParam = (searchParams.get('state') as 'open' | 'closed' | 'all') ?? 'open';
        const sortParam = (searchParams.get('sort') as 'created' | 'updated' | 'comments') ?? 'created';
        const dirParam = (searchParams.get('direction') as 'asc' | 'desc') ?? 'desc';
        const issues = store.listIssues(repo, { state: stateParam, sort: sortParam, direction: dirParam });
        sendJson(res, 200, issues);
        return true;
      }
    }
  }

  // 3a. GET /api/v3/repos/{owner}/{repo}
  if (method === 'GET' && subPath === '') {
    sendJson(res, 200, repo);
    return true;
  }

  // 3b. PATCH /api/v3/repos/{owner}/{repo}
  if (method === 'PATCH' && subPath === '') {
    let body: { description?: string | null; default_branch?: string };
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return true;
    }
    const updated = store.patchRepo(owner, repoName, body);
    sendJson(res, 200, updated);
    return true;
  }

  // 3c. DELETE /api/v3/repos/{owner}/{repo}
  if (method === 'DELETE' && subPath === '') {
    store.deleteRepo(owner, repoName);
    res.writeHead(204, { 'x-github-request-id': 'req-' + Date.now() });
    res.end();
    return true;
  }

  // 3d. Branches: GET /api/v3/repos/{owner}/{repo}/branches
  if (method === 'GET' && subPath === 'branches') {
    const branches = store.listBranches(repo);
    sendJson(res, 200, branches);
    return true;
  }

  // 3e. Git Refs: POST /api/v3/repos/{owner}/{repo}/git/refs
  if (method === 'POST' && subPath === 'git/refs') {
    let body: { ref?: string; sha?: string };
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return true;
    }
    if (!body.ref || !body.sha) {
      sendJson(res, 422, { message: 'ref and sha are required' });
      return true;
    }
    const branchName = body.ref.replace(/^refs\/heads\//, '');
    const refKey = store.createBranch(repo, branchName, body.sha);
    sendJson(res, 201, {
      ref: refKey,
      node_id: Buffer.from(`011:Ref${refKey}`).toString('base64'),
      url: `/api/v3/repos/${owner}/${repoName}/git/${refKey}`,
      object: { sha: body.sha, type: 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/commits/${body.sha}` },
    });
    return true;
  }

  // 3f. Commits: GET /api/v3/repos/{owner}/{repo}/commits
  if (method === 'GET' && subPath === 'commits') {
    const target = searchParams.get('sha') ?? repo.default_branch;
    const commits = store.listCommits(repo, target);
    const result = commits.map((c) => ({
      sha: c.sha,
      node_id: Buffer.from(`010:Commit${c.sha}`).toString('base64'),
      commit: {
        author: c.author,
        committer: c.committer,
        message: c.message,
        tree: { sha: c.treeSha },
      },
      parents: c.parents.map((p) => ({ sha: p })),
    }));
    sendJson(res, 200, result);
    return true;
  }

  // 3g. Contents API: /api/v3/repos/{owner}/{repo}/contents/{path...}
  if (subPath.startsWith('contents/') || subPath === 'contents') {
    const filePath = subPath.startsWith('contents/') ? subPath.slice('contents/'.length) : '';
    const ref = searchParams.get('ref') ?? repo.default_branch;

    if (method === 'GET') {
      const contentResult = store.getContent(repo, ref, filePath);
      if (!contentResult) {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }

      if (contentResult.type === 'file') {
        const file = contentResult.entry;
        const b64 = file.content.toString('base64');
        sendJson(res, 200, {
          name: file.path.split('/').pop(),
          path: file.path,
          sha: file.oid,
          size: file.size,
          type: 'file',
          content: b64,
          encoding: 'base64',
        });
        return true;
      }

      // Directory listing
      sendJson(res, 200, contentResult.entries);
      return true;
    }

    if (method === 'PUT') {
      let body: { message?: string; content?: string; branch?: string; sha?: string };
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return true;
      }

      if (!body.message || body.content === undefined) {
        sendJson(res, 422, { message: 'message and content are required' });
        return true;
      }

      const rawBuffer = Buffer.from(body.content, 'base64');
      try {
        const putResult = store.putContent(repo, body.branch, filePath, rawBuffer, body.message, body.sha);
        const status = putResult.isCreate ? 201 : 200;
        sendJson(res, status, {
          content: {
            name: filePath.split('/').pop(),
            path: filePath,
            sha: putResult.contentSha,
            size: putResult.size,
            type: 'file',
            encoding: 'base64',
          },
          commit: {
            sha: putResult.commitSha,
            message: body.message,
          },
        });
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number })?.statusCode ?? 500;
        sendJson(res, statusCode, { message: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    if (method === 'DELETE') {
      let body: { message?: string; sha?: string; branch?: string };
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return true;
      }

      if (!body.message || !body.sha) {
        sendJson(res, 422, { message: 'message and sha are required' });
        return true;
      }

      try {
        const delResult = store.deleteContent(repo, body.branch, filePath, body.message, body.sha);
        sendJson(res, 200, { commit: { sha: delResult.commitSha } });
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number })?.statusCode ?? 500;
        sendJson(res, statusCode, { message: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
  }

  // 3h. Labels: POST /api/v3/repos/{owner}/{repo}/labels
  if (method === 'POST' && subPath === 'labels') {
    let body: { name?: string; color?: string; description?: string | null };
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return true;
    }
    if (!body.name) {
      sendJson(res, 422, { message: 'Label name is required' });
      return true;
    }
    const label = store.createLabel(repo, body.name, body.color ?? 'ededed', body.description ?? null);
    sendJson(res, 201, label);
    return true;
  }



  // 3l. Pull Requests: /api/v3/repos/{owner}/{repo}/pulls
  if (subPath === 'pulls') {
    if (method === 'POST') {
      let body: { title?: string; head?: string; base?: string; body?: string };
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return true;
      }
      if (!body.title || !body.head || !body.base) {
        sendJson(res, 422, { message: 'title, head, and base are required' });
        return true;
      }
      const pr = store.createPull(repo, VIEWER, body.title, body.head, body.base, body.body ?? '');
      sendJson(res, 201, pr);
      return true;
    }

    if (method === 'GET') {
      const stateParam = (searchParams.get('state') as 'open' | 'closed' | 'all') ?? 'open';
      const pulls = store.listPulls(repo, { state: stateParam });
      sendJson(res, 200, pulls);
      return true;
    }
  }

  // 3m. Pull Request Files: GET /api/v3/repos/{owner}/{repo}/pulls/{number}/files
  const prFilesMatch = subPath.match(/^pulls\/(\d+)\/files$/);
  if (prFilesMatch && method === 'GET') {
    const num = parseInt(prFilesMatch[1], 10);
    const pr = store.getPull(repo, num);
    if (!pr) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    const files = store.getPullFiles(repo, num);
    sendJson(res, 200, files);
    return true;
  }

  // 3n. Single Pull Request: GET /api/v3/repos/{owner}/{repo}/pulls/{number}
  const prMatch = subPath.match(/^pulls\/(\d+)$/);
  if (prMatch && method === 'GET') {
    const num = parseInt(prMatch[1], 10);
    const pr = store.getPull(repo, num);
    if (!pr) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    sendJson(res, 200, pr);
    return true;
  }

  // 3o. Merge Pull Request: PUT /api/v3/repos/{owner}/{repo}/pulls/{number}/merge
  const prMergeMatch = subPath.match(/^pulls\/(\d+)\/merge$/);
  if (prMergeMatch && method === 'PUT') {
    const num = parseInt(prMergeMatch[1], 10);
    let body: { commit_title?: string; commit_message?: string; merge_method?: string } = {};
    try {
      body = await readJsonBody(req);
    } catch {
      // Body is optional on merge
    }
    try {
      const mergeResult = store.mergePull(repo, num, body.commit_message ?? body.commit_title);
      sendJson(res, 200, mergeResult);
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number })?.statusCode ?? 500;
      sendJson(res, statusCode, { message: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  return false;
}
