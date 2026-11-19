// src/graphql.ts — Native GraphQL v4 Engine for github-core-clone-01.
// 100% pure TypeScript, zero external dependencies.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { store, VIEWER } from './store.ts';
import type { Issue, PullRequest, RepoRecord } from './types.ts';

// ---------------------------------------------------------------------------------------------------------
// AST Types
// ---------------------------------------------------------------------------------------------------------

export interface FieldNode {
  kind: 'Field';
  name: string;
  alias?: string;
  args: Record<string, any>;
  selectionSet?: SelectionNode[];
}

export interface InlineFragmentNode {
  kind: 'InlineFragment';
  typeCondition: string;
  selectionSet: SelectionNode[];
}

export type SelectionNode = FieldNode | InlineFragmentNode;

export interface OperationNode {
  kind: 'Operation';
  operation: 'query' | 'mutation';
  name?: string;
  variableDefs: Map<string, { type: string }>;
  selectionSet: SelectionNode[];
}

// ---------------------------------------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------------------------------------

interface Token {
  type: 'NAME' | 'INT' | 'STRING' | 'PUNCT';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (['{', '}', '(', ')', '[', ']', ':', '!', '$'].includes(ch)) {
      tokens.push({ type: 'PUNCT', value: ch });
      i++;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ type: 'PUNCT', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '"') {
      let str = '';
      i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          str += source[i + 1];
          i += 2;
        } else {
          str += source[i];
          i++;
        }
      }
      i++; // skip closing quote
      tokens.push({ type: 'STRING', value: str });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(source[i + 1] ?? ''))) {
      let numStr = ch;
      i++;
      while (i < source.length && /[0-9]/.test(source[i])) {
        numStr += source[i];
        i++;
      }
      tokens.push({ type: 'INT', value: numStr });
      continue;
    }
    if (/[_a-zA-Z]/.test(ch)) {
      let name = '';
      while (i < source.length && /[_a-zA-Z0-9]/.test(source[i])) {
        name += source[i];
        i++;
      }
      tokens.push({ type: 'NAME', value: name });
      continue;
    }
    i++;
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------------------

class Parser {
  private pos = 0;
  private tokens: Token[];
  private variables: Record<string, any>;

  constructor(tokens: Token[], variables: Record<string, any>) {
    this.tokens = tokens;
    this.variables = variables;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private matchPunct(p: string): boolean {
    const tok = this.peek();
    if (tok && tok.type === 'PUNCT' && tok.value === p) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expectPunct(p: string): void {
    if (!this.matchPunct(p)) {
      throw new Error(`Expected punctuation '${p}', got '${this.peek()?.value}'`);
    }
  }

  private expectName(): string {
    const tok = this.next();
    if (!tok || tok.type !== 'NAME') {
      throw new Error(`Expected name, got '${tok?.value}'`);
    }
    return tok.value;
  }

  public parse(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | undefined;

    const tok = this.peek();
    if (tok && tok.type === 'NAME' && (tok.value === 'query' || tok.value === 'mutation')) {
      operation = this.next().value as 'query' | 'mutation';
      if (this.peek() && this.peek()!.type === 'NAME') {
        name = this.next().value;
      }
    }

    // Optional variable definitions ($owner: String!, $name: String!)
    const variableDefs = new Map<string, { type: string }>();
    if (this.matchPunct('(')) {
      while (!this.matchPunct(')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        let varType = this.expectName();
        while (this.matchPunct('!')) {
          varType += '!';
        }
        variableDefs.set(varName, { type: varType });
      }
    }

    const selectionSet = this.parseSelectionSet();
    return {
      kind: 'Operation',
      operation,
      name,
      variableDefs,
      selectionSet,
    };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.matchPunct('}')) {
      if (this.matchPunct('...')) {
        const on = this.expectName();
        if (on !== 'on') throw new Error(`Expected 'on' after '...', got '${on}'`);
        const typeCondition = this.expectName();
        const subSet = this.parseSelectionSet();
        selections.push({
          kind: 'InlineFragment',
          typeCondition,
          selectionSet: subSet,
        });
      } else {
        const first = this.expectName();
        let name = first;
        let alias: string | undefined;
        if (this.matchPunct(':')) {
          alias = first;
          name = this.expectName();
        }

        const args: Record<string, any> = {};
        if (this.matchPunct('(')) {
          while (!this.matchPunct(')')) {
            const argName = this.expectName();
            this.expectPunct(':');
            args[argName] = this.parseValue();
          }
        }

        let subSet: SelectionNode[] | undefined;
        if (this.peek() && this.peek()!.type === 'PUNCT' && this.peek()!.value === '{') {
          subSet = this.parseSelectionSet();
        }

        selections.push({
          kind: 'Field',
          name,
          alias,
          args,
          selectionSet: subSet,
        });
      }
    }
    return selections;
  }

  private parseValue(): any {
    const tok = this.next();
    if (!tok) throw new Error('Unexpected end of input while parsing value');

    if (tok.type === 'PUNCT' && tok.value === '$') {
      const varName = this.expectName();
      return this.variables[varName];
    }
    if (tok.type === 'INT') {
      return parseInt(tok.value, 10);
    }
    if (tok.type === 'STRING') {
      return tok.value;
    }
    if (tok.type === 'NAME') {
      if (tok.value === 'true') return true;
      if (tok.value === 'false') return false;
      if (tok.value === 'null') return null;
      return tok.value; // enum value or identifier
    }
    if (tok.type === 'PUNCT' && tok.value === '[') {
      const arr: any[] = [];
      while (!this.matchPunct(']')) {
        arr.push(this.parseValue());
      }
      return arr;
    }
    if (tok.type === 'PUNCT' && tok.value === '{') {
      const obj: Record<string, any> = {};
      while (!this.matchPunct('}')) {
        const key = this.expectName();
        this.expectPunct(':');
        obj[key] = this.parseValue();
      }
      return obj;
    }
    throw new Error(`Unexpected token '${tok.value}' for value`);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Resolver / Executor
// ---------------------------------------------------------------------------------------------------------

export interface GraphQLExecutionResult {
  data?: Record<string, any> | null;
  errors?: Array<{ message: string; locations?: any[]; path?: string[] }>;
}

export function executeGraphQL(
  documentStr: string,
  variables: Record<string, any> = {},
): GraphQLExecutionResult {
  let operation: OperationNode;
  try {
    const tokens = tokenize(documentStr);
    const parser = new Parser(tokens, variables);
    operation = parser.parse();
  } catch (err: any) {
    return {
      errors: [{ message: `GraphQL syntax error: ${err.message}` }],
    };
  }

  const errors: Array<{ message: string }> = [];
  const data: Record<string, any> = {};

  for (const selection of operation.selectionSet) {
    if (selection.kind === 'InlineFragment') continue;
    const fieldKey = selection.alias ?? selection.name;

    try {
      if (operation.operation === 'mutation') {
        const result = resolveMutation(selection, variables, errors);
        data[fieldKey] = result;
      } else {
        const result = resolveQuery(selection, variables, errors);
        data[fieldKey] = result;
      }
    } catch (err: any) {
      errors.push({ message: err.message ?? String(err) });
    }
  }

  if (errors.length > 0) {
    // If validation error like invalidField, GitHub returns { data: null, errors } or { errors }
    return {
      data: Object.keys(data).length > 0 ? data : null,
      errors,
    };
  }

  return { data };
}

function resolveQuery(
  field: FieldNode,
  variables: Record<string, any>,
  errors: Array<{ message: string }>,
): any {
  // 1. viewer
  if (field.name === 'viewer') {
    const viewerData: Record<string, any> = {};
    if (field.selectionSet) {
      for (const sel of field.selectionSet) {
        if (sel.kind !== 'Field') continue;
        if (sel.name === 'login') {
          viewerData[sel.alias ?? sel.name] = VIEWER.login;
        } else if (sel.name === 'name') {
          viewerData[sel.alias ?? sel.name] = VIEWER.name;
        } else if (sel.name === 'id') {
          viewerData[sel.alias ?? sel.name] = Buffer.from(`04:User${VIEWER.id}`).toString('base64');
        } else {
          // Unknown field on User
          errors.push({ message: `Field "${sel.name}" does not exist on type "User".` });
          return null;
        }
      }
    }
    return viewerData;
  }

  // 2. __type
  if (field.name === '__type') {
    const typeName = field.args.name;
    return resolveTypeIntrospection(typeName, field.selectionSet);
  }

  // 3. repository
  if (field.name === 'repository') {
    const owner = field.args.owner;
    const name = field.args.name;
    const repo = store.getRepo(owner, name);
    if (!repo) {
      return null;
    }
    return resolveRepositoryFields(repo, field.selectionSet, variables, errors);
  }

  // 4. node(id:)
  if (field.name === 'node') {
    const id = field.args.id;
    return resolveNode(id, field.selectionSet, variables, errors);
  }

  errors.push({ message: `Cannot query field "${field.name}" on type "Query".` });
  return null;
}

function resolveTypeIntrospection(typeName: string, selectionSet?: SelectionNode[]): any {
  const result: Record<string, any> = {};
  if (!selectionSet) return result;

  for (const sel of selectionSet) {
    if (sel.kind !== 'Field') continue;
    const key = sel.alias ?? sel.name;

    if (sel.name === 'fields') {
      let fieldNames: string[] = [];
      if (typeName === 'Issue') {
        fieldNames = ['id', 'number', 'title', 'state', 'body'];
      } else if (typeName === 'PullRequest') {
        fieldNames = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'];
      } else if (typeName === 'Repository') {
        fieldNames = [
          'id',
          'databaseId',
          'name',
          'nameWithOwner',
          'owner',
          'defaultBranchRef',
          'viewerPermission',
          'hasIssuesEnabled',
          'issue',
          'issues',
          'pullRequests',
          'pullRequest',
        ];
      }
      result[key] = fieldNames.map((n) => ({ name: n }));
    } else if (sel.name === 'enumValues') {
      let enumNames: string[] = [];
      if (typeName === 'SearchType') {
        enumNames = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'];
      } else if (typeName === 'IssueState') {
        enumNames = ['OPEN', 'CLOSED'];
      } else if (typeName === 'PullRequestState') {
        enumNames = ['OPEN', 'CLOSED', 'MERGED'];
      } else if (typeName === 'MergeableState') {
        enumNames = ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'];
      }
      result[key] = enumNames.map((n) => ({ name: n }));
    }
  }

  return result;
}

function resolveRepositoryFields(
  repo: RepoRecord,
  selectionSet: SelectionNode[] | undefined,
  variables: Record<string, any>,
  errors: Array<{ message: string }>,
): any {
  if (!selectionSet) return {};
  const res: Record<string, any> = {};

  for (const sel of selectionSet) {
    if (sel.kind !== 'Field') continue;
    const key = sel.alias ?? sel.name;

    switch (sel.name) {
      case 'id':
        res[key] = repo.node_id;
        break;
      case 'databaseId':
        res[key] = repo.id;
        break;
      case 'name':
        res[key] = repo.name;
        break;
      case 'nameWithOwner':
        res[key] = repo.full_name;
        break;
      case 'owner':
        res[key] = { login: repo.owner.login };
        break;
      case 'defaultBranchRef':
        res[key] = { name: repo.default_branch };
        break;
      case 'viewerPermission':
        res[key] = 'ADMIN';
        break;
      case 'hasIssuesEnabled':
        res[key] = true;
        break;
      case 'issue': {
        const num = sel.args.number;
        const issue = repo.issues.get(num);
        if (!issue) {
          res[key] = null;
        } else {
          res[key] = resolveIssueFields(issue, sel.selectionSet);
        }
        break;
      }
      case 'issues': {
        const first = sel.args.first ?? 10;
        const states = sel.args.states as string[] | undefined;
        const orderBy = sel.args.orderBy as { field: string; direction: string } | undefined;
        const after = sel.args.after as string | null | undefined;

        let issues = Array.from(repo.issues.values());

        // State filter (e.g. states: [OPEN])
        if (states && states.length > 0) {
          const upperStates = states.map((s) => s.toUpperCase());
          issues = issues.filter((i) => upperStates.includes(i.state.toUpperCase()));
        }

        // Sort filter
        const dir = orderBy?.direction?.toUpperCase() ?? 'DESC';
        issues.sort((a, b) => {
          if (dir === 'ASC') return a.number - b.number;
          return b.number - a.number;
        });

        // Cursor pagination
        if (after) {
          let afterNum: number | null = null;
          try {
            const dec = Buffer.from(after, 'base64').toString('utf8');
            afterNum = parseInt(dec, 10);
          } catch {
            afterNum = parseInt(after, 10);
          }
          if (!isNaN(afterNum as number)) {
            const idx = issues.findIndex((i) => i.number === afterNum);
            if (idx >= 0) {
              issues = issues.slice(idx + 1);
            }
          }
        }

        const nodesToReturn = issues.slice(0, first);
        const hasNextPage = issues.length > first;
        const lastNode = nodesToReturn[nodesToReturn.length - 1];
        const endCursor = lastNode ? Buffer.from(String(lastNode.number)).toString('base64') : null;

        res[key] = {
          nodes: nodesToReturn.map((iss) => resolveIssueFields(iss, getSubSelectionSet(sel, 'nodes'))),
          pageInfo: {
            hasNextPage,
            endCursor,
          },
        };
        break;
      }
      case 'pullRequests': {
        const first = sel.args.first ?? 10;
        const prs = Array.from(repo.pulls.values()).slice(0, first);
        res[key] = {
          nodes: prs.map((pr) => resolvePullFields(pr, getSubSelectionSet(sel, 'nodes'))),
        };
        break;
      }
      case 'pullRequest': {
        const num = sel.args.number;
        const pr = repo.pulls.get(num);
        if (!pr) {
          res[key] = null;
        } else {
          res[key] = resolvePullFields(pr, sel.selectionSet, repo);
        }
        break;
      }
      default:
        errors.push({ message: `Cannot query field "${sel.name}" on type "Repository".` });
        break;
    }
  }

  return res;
}

function getSubSelectionSet(field: FieldNode, subName: string): SelectionNode[] | undefined {
  if (!field.selectionSet) return undefined;
  const sub = field.selectionSet.find((s) => s.kind === 'Field' && s.name === subName) as FieldNode | undefined;
  return sub?.selectionSet;
}

function resolveIssueFields(issue: Issue, selectionSet?: SelectionNode[]): any {
  if (!selectionSet) {
    return {
      id: issue.node_id,
      number: issue.number,
      title: issue.title,
      state: issue.state.toUpperCase(),
      body: issue.body,
    };
  }
  const res: Record<string, any> = {};
  for (const sel of selectionSet) {
    if (sel.kind !== 'Field') continue;
    const key = sel.alias ?? sel.name;
    switch (sel.name) {
      case 'id':
        res[key] = issue.node_id;
        break;
      case 'number':
        res[key] = issue.number;
        break;
      case 'title':
        res[key] = issue.title;
        break;
      case 'state':
        res[key] = issue.state.toUpperCase();
        break;
      case 'body':
        res[key] = issue.body;
        break;
    }
  }
  return res;
}

function resolvePullFields(pr: PullRequest, selectionSet?: SelectionNode[], repo?: RepoRecord): any {
  if (!selectionSet) {
    return {
      id: pr.node_id,
      number: pr.number,
      state: pr.merged ? 'MERGED' : pr.state.toUpperCase(),
      merged: pr.merged,
      headRefName: pr.head.ref,
      baseRefName: pr.base.ref,
      mergeable: pr.mergeable ? 'MERGEABLE' : 'CONFLICTING',
    };
  }

  const res: Record<string, any> = {};
  for (const sel of selectionSet) {
    if (sel.kind !== 'Field') continue;
    const key = sel.alias ?? sel.name;
    switch (sel.name) {
      case 'id':
        res[key] = pr.node_id;
        break;
      case 'number':
        res[key] = pr.number;
        break;
      case 'state':
        res[key] = pr.merged ? 'MERGED' : pr.state.toUpperCase();
        break;
      case 'merged':
        res[key] = pr.merged;
        break;
      case 'headRefName':
        res[key] = pr.head.ref;
        break;
      case 'baseRefName':
        res[key] = pr.base.ref;
        break;
      case 'mergeable':
        res[key] = pr.mergeable ? 'MERGEABLE' : 'CONFLICTING';
        break;
      case 'files': {
        const filesList = repo?.pullFiles.get(pr.number) ?? [];
        res[key] = {
          nodes: filesList.map((f) => ({ path: f.filename })),
        };
        break;
      }
    }
  }
  return res;
}

function resolveNode(
  id: string,
  selectionSet: SelectionNode[] | undefined,
  variables: Record<string, any>,
  errors: Array<{ message: string }>,
): any {
  // Check if id is a repository
  const repo = store.findRepoByGlobalId(id);
  if (repo) {
    const res: Record<string, any> = { id: repo.node_id };
    if (selectionSet) {
      for (const sel of selectionSet) {
        if (sel.kind === 'Field') {
          if (sel.name === 'id') res[sel.alias ?? sel.name] = repo.node_id;
        } else if (sel.kind === 'InlineFragment') {
          if (sel.typeCondition === 'Repository') {
            for (const f of sel.selectionSet) {
              if (f.kind !== 'Field') continue;
              if (f.name === 'name') res[f.alias ?? f.name] = repo.name;
              else if (f.name === 'nameWithOwner') res[f.alias ?? f.name] = repo.full_name;
              else if (f.name === 'id') res[f.alias ?? f.name] = repo.node_id;
            }
          }
        }
      }
    }
    return res;
  }

  // Check if id is an issue
  const issueRes = store.findIssueByGlobalId(id);
  if (issueRes) {
    return { id: issueRes.issue.node_id, number: issueRes.issue.number };
  }

  // Check if id is a PR
  const pullRes = store.findPullByGlobalId(id);
  if (pullRes) {
    return { id: pullRes.pr.node_id, number: pullRes.pr.number };
  }

  return null;
}

function resolveMutation(
  field: FieldNode,
  variables: Record<string, any>,
  errors: Array<{ message: string }>,
): any {
  const input = field.args.input ?? {};

  switch (field.name) {
    case 'createIssue': {
      const repo = store.findRepoByGlobalId(input.repositoryId);
      if (!repo) throw new Error(`Repository not found for repositoryId '${input.repositoryId}'`);
      const issue = store.createIssue(repo, VIEWER, input.title, input.body ?? '');
      return {
        issue: {
          number: issue.number,
          id: issue.node_id,
        },
      };
    }
    case 'closeIssue': {
      const res = store.findIssueByGlobalId(input.issueId);
      if (!res) throw new Error(`Issue not found for issueId '${input.issueId}'`);
      store.patchIssue(res.repo, res.issue.number, { state: 'closed' });
      return {
        issue: {
          number: res.issue.number,
          id: res.issue.node_id,
          state: 'CLOSED',
        },
      };
    }
    case 'createPullRequest': {
      const repo = store.findRepoByGlobalId(input.repositoryId);
      if (!repo) throw new Error(`Repository not found for repositoryId '${input.repositoryId}'`);
      const pr = store.createPull(
        repo,
        VIEWER,
        input.title,
        input.headRefName,
        input.baseRefName,
        input.body ?? '',
      );
      return {
        pullRequest: {
          number: pr.number,
          id: pr.node_id,
          state: 'OPEN',
          headRefName: pr.head.ref,
          baseRefName: pr.base.ref,
        },
      };
    }
    case 'mergePullRequest': {
      const res = store.findPullByGlobalId(input.pullRequestId);
      if (!res) throw new Error(`PullRequest not found for pullRequestId '${input.pullRequestId}'`);
      store.mergePull(res.repo, res.pr.number);
      return {
        pullRequest: {
          number: res.pr.number,
          merged: true,
          state: 'MERGED',
        },
      };
    }
    case 'addComment': {
      const res = store.findIssueByGlobalId(input.subjectId);
      if (!res) throw new Error(`Subject not found for subjectId '${input.subjectId}'`);
      const comment = store.addComment(res.repo, VIEWER, res.issue.number, input.body);
      return {
        commentEdge: {
          node: {
            id: comment.node_id,
            body: comment.body,
          },
        },
      };
    }
    default:
      errors.push({ message: `Cannot mutate field "${field.name}" on type "Mutation".` });
      return null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// HTTP Handler
// ---------------------------------------------------------------------------------------------------------

export async function handleGraphQLRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): Promise<void> {
  const JSON_TYPE = 'application/json; charset=utf-8';

  // Support batched operations: array of { query, variables }
  if (Array.isArray(body)) {
    const results: GraphQLExecutionResult[] = [];
    for (const item of body) {
      if (item && typeof item === 'object' && typeof item.query === 'string') {
        results.push(executeGraphQL(item.query, item.variables ?? {}));
      } else {
        results.push({ errors: [{ message: 'Invalid batched operation payload' }] });
      }
    }
    const text = `${JSON.stringify(results)}\n`;
    res.writeHead(200, {
      'content-type': JSON_TYPE,
      'content-length': Buffer.byteLength(text),
    });
    res.end(text);
    return;
  }

  // Single operation
  const payload = body as { query?: string; variables?: Record<string, any> };
  if (!payload || typeof payload.query !== 'string') {
    const text = `${JSON.stringify({ errors: [{ message: 'Missing query in request body' }] })}\n`;
    res.writeHead(200, {
      'content-type': JSON_TYPE,
      'content-length': Buffer.byteLength(text),
    });
    res.end(text);
    return;
  }

  const result = executeGraphQL(payload.query, payload.variables ?? {});
  const text = `${JSON.stringify(result)}\n`;
  res.writeHead(200, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}
