// src/mcp.ts — Model Context Protocol (MCP) server for github-core-clone-01.
// Supports both Modern (2026-07-28) server/discover and Legacy (2025-11-25) initialize,
// tools/list, and tools/call for 6 core GitHub forge capabilities.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { store, VIEWER, type RepoRecord } from './store.ts';
import type { User } from './types.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

export interface McpToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

export const MCP_TOOLS: readonly McpToolSchema[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The name of the repository.',
        },
        description: {
          type: 'string',
          description: 'A short description of the repository.',
        },
        private: {
          type: 'boolean',
          description: 'Whether the repository is private.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get information about a specific repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          description: 'The account owner of the repository.',
        },
        repo: {
          type: 'string',
          description: 'The name of the repository.',
        },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          description: 'The account owner of the repository.',
        },
        repo: {
          type: 'string',
          description: 'The name of the repository.',
        },
        title: {
          type: 'string',
          description: 'The title of the issue.',
        },
        body: {
          type: 'string',
          description: 'The contents of the issue.',
        },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          description: 'The account owner of the repository.',
        },
        repo: {
          type: 'string',
          description: 'The name of the repository.',
        },
        state: {
          type: 'string',
          description: 'Indicates the state of the issues to return: open, closed, or all.',
          enum: ['open', 'closed', 'all'],
        },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a new pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          description: 'The account owner of the repository.',
        },
        repo: {
          type: 'string',
          description: 'The name of the repository.',
        },
        title: {
          type: 'string',
          description: 'The title of the new pull request.',
        },
        head: {
          type: 'string',
          description: 'The name of the branch where your changes are implemented.',
        },
        base: {
          type: 'string',
          description: 'The name of the branch you want the changes pulled into.',
        },
        body: {
          type: 'string',
          description: 'The contents of the pull request.',
        },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          description: 'The account owner of the repository.',
        },
        repo: {
          type: 'string',
          description: 'The name of the repository.',
        },
        pull_number: {
          type: 'integer',
          description: 'The number that identifies the pull request.',
        },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

function sendRpcResponse(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': randomBytes(8).toString('hex'),
    'mcp-protocol-version': '2026-07-28',
  });
  res.end(text);
}

function sendRpcResult(res: ServerResponse, id: unknown, result: unknown): void {
  sendRpcResponse(res, 200, {
    jsonrpc: '2.0',
    id: id ?? null,
    result,
  });
}

function sendRpcError(res: ServerResponse, status: number, id: unknown, code: number, message: string, data?: unknown): void {
  const errObj: { code: number; message: string; data?: unknown } = { code, message };
  if (data !== undefined) errObj.data = data;
  sendRpcResponse(res, status, {
    jsonrpc: '2.0',
    id: id ?? null,
    error: errObj,
  });
}

function findTool(name: string): McpToolSchema | undefined {
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const t of MCP_TOOLS) {
    const tNorm = t.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (norm === tNorm || norm.endsWith(tNorm)) {
      return t;
    }
  }
  return undefined;
}

/** Handle incoming POST /mcp JSON-RPC request. */
export async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const rawText = Buffer.concat(chunks).toString('utf8');

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawText);
  } catch {
    // Check 10: a body that is not JSON answers HTTP 400 with JSON-RPC -32700
    const idMatch = rawText.match(/"id"\s*:\s*(\d+|"[^"]*")/);
    let extractedId: string | number | null = null;
    if (idMatch) {
      try {
        extractedId = JSON.parse(idMatch[1]);
      } catch {
        extractedId = idMatch[1];
      }
    }
    sendRpcError(res, 400, extractedId, -32700, 'Parse error');
    return;
  }

  const id = body.id;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = (typeof body.params === 'object' && body.params !== null && !Array.isArray(body.params))
    ? (body.params as Record<string, unknown>)
    : {};

  // 1. Modern 2026-07-28: server/discover
  if (method === 'server/discover') {
    sendRpcResult(res, id, {
      resultType: 'discover',
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'github-core-clone',
        version: '1.0.0',
      },
      _meta: {
        'io.modelcontextprotocol/serverInfo': {
          name: 'github-core-clone',
          version: '1.0.0',
        },
      },
    });
    return;
  }

  // 2. Legacy handshake: initialize
  if (method === 'initialize') {
    sendRpcResult(res, id, {
      protocolVersion: '2025-11-25',
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'github-core-clone',
        version: '1.0.0',
      },
    });
    return;
  }

  // 3. Legacy handshake: notifications/initialized
  if (method === 'notifications/initialized') {
    sendRpcResponse(res, 200, { jsonrpc: '2.0' });
    return;
  }

  // 4. tools/list
  if (method === 'tools/list') {
    sendRpcResult(res, id, {
      tools: MCP_TOOLS,
    });
    return;
  }

  // 5. tools/call
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const toolArgs = (typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments))
      ? (params.arguments as Record<string, unknown>)
      : {};

    const tool = findTool(toolName);
    if (!tool) {
      // Check 9: an unknown tool name answers a JSON-RPC error (-32602 or -32601), never HTTP 500
      sendRpcError(res, 200, id, -32601, `Tool not found: ${toolName}`);
      return;
    }

    // Check 11: tools/call with missing required arguments answers isError:true or JSON-RPC -32602
    for (const reqField of tool.inputSchema.required) {
      const val = toolArgs[reqField];
      if (val === undefined || val === null || val === '') {
        sendRpcResult(res, id, {
          content: [{ type: 'text', text: `Missing required argument: ${reqField}` }],
          isError: true,
        });
        return;
      }
    }

    // Execute tool
    switch (tool.name) {
      case 'create_repo': {
        const name = String(toolArgs.name);
        const description = typeof toolArgs.description === 'string' ? toolArgs.description : null;
        const isPrivate = typeof toolArgs.private === 'boolean' ? toolArgs.private : true;
        const ownerLogin = typeof toolArgs.owner === 'string' && toolArgs.owner.trim() ? String(toolArgs.owner) : VIEWER.login;
        const ownerUser: User = (ownerLogin === VIEWER.login)
          ? VIEWER
          : { id: 1000, login: ownerLogin, name: ownerLogin, email: `${ownerLogin}@example.com`, type: 'User' };
        try {
          const repo = store.createRepo(ownerUser, name, isPrivate, description);
          const resultData = {
            id: repo.id,
            node_id: repo.node_id,
            name: repo.name,
            full_name: repo.full_name,
            private: repo.private,
            description: repo.description,
            default_branch: repo.default_branch,
            owner: {
              login: repo.owner.login,
              id: repo.owner.id,
            },
          };
          sendRpcResult(res, id, {
            content: [{ type: 'text', text: JSON.stringify(resultData, null, 2) }],
            structuredContent: resultData,
          });
        } catch (err: unknown) {
          sendRpcResult(res, id, {
            content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          });
        }
        return;
      }

      case 'get_repo': {
        const owner = String(toolArgs.owner);
        const repoName = String(toolArgs.repo);
        const repo = store.getRepo(owner, repoName);
        if (!repo) {
          sendRpcResult(res, id, {
            content: [{ type: 'text', text: `Repository ${owner}/${repoName} not found` }],
            isError: true,
          });
          return;
        }
        const resultData = {
          id: repo.id,
          node_id: repo.node_id,
          name: repo.name,
          full_name: repo.full_name,
          private: repo.private,
          description: repo.description,
          default_branch: repo.default_branch,
          owner: {
            login: repo.owner.login,
            id: repo.owner.id,
          },
        };
        sendRpcResult(res, id, {
          content: [{ type: 'text', text: JSON.stringify(resultData, null, 2) }],
          structuredContent: resultData,
        });
        return;
      }

      case 'create_issue': {
        const owner = String(toolArgs.owner);
        const repoName = String(toolArgs.repo);
        const title = String(toolArgs.title);
        const bodyText = typeof toolArgs.body === 'string' ? toolArgs.body : '';
        const repo = store.getRepo(owner, repoName);
        if (!repo) {
          sendRpcResult(res, id, {
            content: [{ type: 'text', text: `Repository ${owner}/${repoName} not found` }],
            isError: true,
          });
          return;
        }
        try {
          const issue = store.createIssue(repo, VIEWER, title, bodyText, []);
          const resultData = {
            id: issue.id,
            node_id: issue.node_id,
            number: issue.number,
            title: issue.title,
            body: issue.body,
            state: issue.state,
            user: {
              login: issue.user.login,
              id: issue.user.id,
            },
            created_at: issue.created_at,
            updated_at: issue.updated_at,
          };
          sendRpcResult(res, id, {
            content: [{ type: 'text', text: JSON.stringify(resultData, null, 2) }],
            structuredContent: resultData,
          });
        } catch (err: unknown) {
          sendRpcResult(res, id, {
            content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          });
        }
        return;
      }

      case 'list_issues': {
        const owner = String(toolArgs.owner);
        const repoName = String(toolArgs.repo);
        const state = typeof toolArgs.state === 'string' ? toolArgs.state : 'open';
        const repo = store.getRepo(owner, repoName);
        if (!repo) {
          sendRpcResult(res, id, {
            content: [{ type: 'text', text: `Repository ${owner}/${repoName} not found` }],
            isError: true,
          });
          return;
        }
        const allIssues = Array.from(repo.issues.values());
        const filtered = allIssues.filter(iss => {
          if (state === 'all') return true;
          if (state === 'closed') return iss.state === 'closed';
          return iss.state === 'open';
        });
        const resultData = filtered.map(iss => ({
          id: iss.id,
          node_id: iss.node_id,
          number: iss.number,
          title: iss.title,
          body: iss.body,
          state: iss.state,
          user: {
            login: iss.user.login,
            id: iss.user.id,
          },
          created_at: iss.created_at,
          updated_at: iss.updated_at,
        }));
        sendRpcResult(res, id, {
          content: [{ type: 'text', text: JSON.stringify(resultData, null, 2) }],
          structuredContent: resultData,
        });
        return;
      }

      case 'create_pull_request': {
        const owner = String(toolArgs.owner);
        const repoName = String(toolArgs.repo);
        const title = String(toolArgs.title);
        const head = String(toolArgs.head);
        const base = String(toolArgs.base);
        const bodyText = typeof toolArgs.body === 'string' ? toolArgs.body : '';
        const repo = store.getRepo(owner, repoName);
        if (!repo) {
          sendRpcResult(res, id, {
            content: [{ type: 'text', text: `Repository ${owner}/${repoName} not found` }],
            isError: true,
          });
          return;
        }
        try {
          const pull = store.createPull(repo, VIEWER, title, head, base, bodyText);
          const resultData = {
            id: pull.id,
            node_id: pull.node_id,
            number: pull.number,
            title: pull.title,
            body: pull.body,
            state: pull.state,
            merged: pull.merged,
            head: {
              ref: pull.head.ref,
              label: pull.head.label,
              sha: pull.head.sha,
            },
            base: {
              ref: pull.base.ref,
              label: pull.base.label,
              sha: pull.base.sha,
            },
            user: {
              login: pull.user.login,
              id: pull.user.id,
            },
            created_at: pull.created_at,
            updated_at: pull.updated_at,
          };
          sendRpcResult(res, id, {
            content: [{ type: 'text', text: JSON.stringify(resultData, null, 2) }],
            structuredContent: resultData,
          });
        } catch (err: unknown) {
          sendRpcResult(res, id, {
            content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          });
        }
        return;
      }

      case 'merge_pull_request': {
        const owner = String(toolArgs.owner);
        const repoName = String(toolArgs.repo);
        const pullNum = typeof toolArgs.pull_number === 'number'
          ? toolArgs.pull_number
          : parseInt(String(toolArgs.pull_number ?? toolArgs.number), 10);
        const repo = store.getRepo(owner, repoName);
        if (!repo) {
          sendRpcResult(res, id, {
            content: [{ type: 'text', text: `Repository ${owner}/${repoName} not found` }],
            isError: true,
          });
          return;
        }
        try {
          const mergeResult = store.mergePull(repo, pullNum);
          sendRpcResult(res, id, {
            content: [{ type: 'text', text: JSON.stringify(mergeResult, null, 2) }],
            structuredContent: mergeResult,
          });
        } catch (err: unknown) {
          sendRpcResult(res, id, {
            content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          });
        }
        return;
      }
    }
  }

  // Unknown method
  sendRpcError(res, 200, id, -32601, `Method not found: ${method}`);
}
