// src/store.ts — High-performance unified in-memory store for github-core-clone-01.

import { createHash } from 'node:crypto';
import { parseCommit, parseTree } from './git-engine.ts';
import type {
  CommitRecord,
  FileEntry,
  GitObject,
  GitObjectType,
  Issue,
  IssueComment,
  Label,
  PullRequest,
  PullRequestFile,
  RepoRecord,
  User,
} from './types.ts';

/** The deterministic viewer user as seeded in wire.ts buildScenario(). */
export const VIEWER: User = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  avatar_url: 'https://avatars.example.invalid/u/1000',
  type: 'User',
  site_admin: false,
});

let cachedTrialNow: string | undefined = undefined;
let cachedUnixSec: number = 0;

/** Deterministic ISO timestamp derived from trial environment. */
export function getNow(): string {
  const trialNow = process.env.MAKEFUN_TRIAL_NOW;
  if (trialNow) {
    if (trialNow !== cachedTrialNow) {
      cachedTrialNow = trialNow;
      cachedUnixSec = Math.floor(new Date(trialNow).getTime() / 1000);
    }
    return cachedTrialNow;
  }
  return new Date().toISOString();
}

/** Deterministic unix seconds for git commit headers. */
export function getUnixSeconds(): number {
  const trialNow = process.env.MAKEFUN_TRIAL_NOW;
  if (trialNow) {
    if (trialNow !== cachedTrialNow) {
      cachedTrialNow = trialNow;
      cachedUnixSec = Math.floor(new Date(trialNow).getTime() / 1000);
    }
    return cachedUnixSec;
  }
  return Math.floor(Date.now() / 1000);
}

/** Compute standard Git SHA-1 object hash: sha1("<type> <size>\0<data>"). */
export function hashGitObject(type: GitObjectType, data: Uint8Array): { oid: string; payload: Buffer } {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  const payload = Buffer.concat([header, data]);
  const oid = createHash('sha1').update(payload).digest('hex');
  return { oid, payload };
}

/** Build a deterministic Git commit payload. */
export function buildCommitObject(
  treeSha: string,
  parents: string[],
  author: { name: string; email: string; date: number },
  message: string,
): { oid: string; payload: Buffer; text: string } {
  let lines = `tree ${treeSha}\n`;
  for (const parent of parents) {
    if (parent && parent !== '0'.repeat(40)) {
      lines += `parent ${parent}\n`;
    }
  }
  const idStr = `${author.name} <${author.email}> ${author.date} +0000`;
  lines += `author ${idStr}\ncommitter ${idStr}\n\n${message.trim()}\n`;

  const buf = Buffer.from(lines, 'utf8');
  const { oid, payload } = hashGitObject('commit', buf);
  return { oid, payload, text: lines };
}

export class MemoryStore {
  private repos = new Map<string, RepoRecord>();
  private nextRepoId = 100;

  /** Canonical repository key in format "owner/repo" (case-insensitive). */
  public repoKey(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  /** Retrieve repository record or undefined. */
  public getRepo(owner: string, name: string): RepoRecord | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  /** Create a new repository record. */
  public createRepo(
    ownerUser: User,
    name: string,
    isPrivate: boolean = true,
    description: string | null = null,
    defaultBranch: string = 'main',
  ): RepoRecord {
    const key = this.repoKey(ownerUser.login, name);
    if (this.repos.has(key)) {
      const err = new Error(`Repository ${ownerUser.login}/${name} already exists`);
      (err as unknown as { statusCode: number }).statusCode = 422;
      throw err;
    }

    const now = getNow();
    const repoId = this.nextRepoId++;
    const repo: RepoRecord = {
      id: repoId,
      node_id: Buffer.from(`010:Repository${repoId}`).toString('base64'),
      name,
      full_name: `${ownerUser.login}/${name}`,
      owner: { ...ownerUser },
      private: isPrivate,
      description,
      default_branch: defaultBranch,
      created_at: now,
      updated_at: now,
      pushed_at: now,
      has_issues: true,
      objects: new Map<string, GitObject>(),
      refs: new Map<string, string>(),
      HEAD: `ref: refs/heads/${defaultBranch}`,
      branchFiles: new Map<string, Map<string, FileEntry>>(),
      branchCommits: new Map<string, CommitRecord[]>(),
      labels: new Map<string, Label>(),
      issues: new Map<number, Issue>(),
      issueComments: new Map<number, IssueComment[]>(),
      pulls: new Map<number, PullRequest>(),
      pullFiles: new Map<number, PullRequestFile[]>(),
      nextIssueNumber: 1,
      nextCommentId: 1,
      nextLabelId: 1,
    };

    // Initialize default branch maps
    repo.branchFiles.set(defaultBranch, new Map<string, FileEntry>());
    repo.branchCommits.set(defaultBranch, []);

    this.repos.set(key, repo);
    return repo;
  }

  /** Update repository metadata (description, etc.). */
  public patchRepo(owner: string, name: string, updates: Partial<{ description: string | null; default_branch: string }>): RepoRecord {
    const repo = this.getRepo(owner, name);
    if (!repo) throw new Error('Repository not found');
    if (updates.description !== undefined) repo.description = updates.description;
    if (updates.default_branch !== undefined) repo.default_branch = updates.default_branch;
    repo.updated_at = getNow();
    return repo;
  }

  /** Delete a repository. */
  public deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  /** List repositories for a user. */
  public listUserRepos(owner: string): RepoRecord[] {
    const lower = owner.toLowerCase();
    const result: RepoRecord[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner.login.toLowerCase() === lower) {
        result.push(repo);
      }
    }
    return result;
  }

  /** Create a branch (ref: refs/heads/<branchName>) pointing to fromSha. */
  public createBranch(repo: RepoRecord, branchName: string, fromSha: string): string {
    const refKey = `refs/heads/${branchName}`;
    repo.refs.set(refKey, fromSha);

    // Initialize branch files from existing base branch or fromSha if exists
    if (!repo.branchFiles.has(branchName)) {
      const sourceFiles = repo.branchFiles.get(repo.default_branch) ?? new Map<string, FileEntry>();
      const newFiles = new Map<string, FileEntry>();
      for (const [p, f] of sourceFiles.entries()) {
        newFiles.set(p, { ...f });
      }
      repo.branchFiles.set(branchName, newFiles);
    }

    if (!repo.branchCommits.has(branchName)) {
      const sourceCommits = repo.branchCommits.get(repo.default_branch) ?? [];
      repo.branchCommits.set(branchName, [...sourceCommits]);
    }

    repo.pushed_at = getNow();
    repo.updated_at = repo.pushed_at;
    return refKey;
  }

  /** List branches for a repository. */
  public listBranches(repo: RepoRecord): Array<{ name: string; commit: { sha: string } }> {
    const list: Array<{ name: string; commit: { sha: string } }> = [];
    const seen = new Set<string>();

    // Add refs/heads/*
    for (const [ref, sha] of repo.refs.entries()) {
      if (ref.startsWith('refs/heads/')) {
        const bName = ref.slice('refs/heads/'.length);
        list.push({ name: bName, commit: { sha } });
        seen.add(bName);
      }
    }

    // Always include default branch if not already added
    if (!seen.has(repo.default_branch)) {
      const headSha = repo.refs.get(`refs/heads/${repo.default_branch}`) ?? '0'.repeat(40);
      list.push({ name: repo.default_branch, commit: { sha: headSha } });
    }

    return list;
  }

  /** Store a file via PUT /contents, committing to the specified or default branch. */
  public putContent(
    repo: RepoRecord,
    targetBranch: string | undefined,
    filePath: string,
    contentBuffer: Buffer,
    message: string,
    expectedSha?: string,
  ): { contentSha: string; commitSha: string; isCreate: boolean; size: number } {
    const branch = targetBranch ?? repo.default_branch;
    const cleanPath = filePath.replace(/^\/+/, '');

    let bFiles = repo.branchFiles.get(branch);
    if (!bFiles) {
      bFiles = new Map<string, FileEntry>();
      repo.branchFiles.set(branch, bFiles);
    }

    let bCommits = repo.branchCommits.get(branch);
    if (!bCommits) {
      bCommits = [];
      repo.branchCommits.set(branch, bCommits);
    }

    const existing = bFiles.get(cleanPath);
    if (expectedSha !== undefined && existing && existing.oid.toLowerCase() !== expectedSha.toLowerCase()) {
      const err = new Error(`Stale sha: expected ${expectedSha}, currently at ${existing.oid}`);
      (err as unknown as { statusCode: number }).statusCode = 409;
      throw err;
    }

    const isCreate = !existing;

    // 1. Store blob
    const { oid: blobSha, payload: blobPayload } = hashGitObject('blob', contentBuffer);
    repo.objects.set(blobSha, { type: 'blob', data: contentBuffer, oid: blobSha });

    // 2. Update branch files map
    bFiles.set(cleanPath, {
      path: cleanPath,
      oid: blobSha,
      content: contentBuffer,
      size: contentBuffer.length,
    });

    // 3. Create dummy tree & commit
    const prevSha = repo.refs.get(`refs/heads/${branch}`);
    const parents = prevSha && prevSha !== '0'.repeat(40) ? [prevSha] : [];
    const { oid: treeSha } = hashGitObject('tree', Buffer.from(`100644 ${cleanPath}\0`, 'utf8'));

    const nowIso = getNow();
    const nowSec = getUnixSeconds();
    const { oid: commitSha } = buildCommitObject(
      treeSha,
      parents,
      { name: repo.owner.name, email: repo.owner.email, date: nowSec },
      message,
    );

    const commitRec: CommitRecord = {
      sha: commitSha,
      message,
      author: { name: repo.owner.name, email: repo.owner.email, date: nowIso },
      committer: { name: repo.owner.name, email: repo.owner.email, date: nowIso },
      parents,
      treeSha,
    };

    bCommits.unshift(commitRec); // newest first
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    repo.pushed_at = nowIso;
    repo.updated_at = nowIso;

    return { contentSha: blobSha, commitSha, isCreate, size: contentBuffer.length };
  }

  /** Get a file or directory listing for a given path and branch. */
  public getContent(
    repo: RepoRecord,
    targetBranch: string | undefined,
    queryPath: string,
  ): { type: 'file'; entry: FileEntry } | { type: 'dir'; entries: Array<{ name: string; path: string; sha: string; size: number; type: 'file' | 'dir' }> } | null {
    const branch = targetBranch ?? repo.default_branch;
    const bFiles = repo.branchFiles.get(branch);
    if (!bFiles) return null;

    const cleanPath = queryPath.replace(/^\/+/, '').replace(/\/+$/, '');

    // Check direct file match
    if (bFiles.has(cleanPath)) {
      return { type: 'file', entry: bFiles.get(cleanPath)! };
    }

    // Check directory match
    const prefix = cleanPath === '' ? '' : `${cleanPath}/`;
    const dirEntries: Array<{ name: string; path: string; sha: string; size: number; type: 'file' | 'dir' }> = [];
    const subdirs = new Set<string>();

    for (const [filePath, file] of bFiles.entries()) {
      if (filePath.startsWith(prefix)) {
        const rest = filePath.slice(prefix.length);
        const slashIdx = rest.indexOf('/');
        if (slashIdx === -1) {
          // Direct child file
          dirEntries.push({
            name: rest,
            path: filePath,
            sha: file.oid,
            size: file.size,
            type: 'file',
          });
        } else {
          // Child directory
          const dirName = rest.slice(0, slashIdx);
          if (!subdirs.has(dirName)) {
            subdirs.add(dirName);
            dirEntries.push({
              name: dirName,
              path: prefix ? `${prefix}${dirName}` : dirName,
              sha: file.oid,
              size: 0,
              type: 'dir',
            });
          }
        }
      }
    }

    if (dirEntries.length > 0) {
      return { type: 'dir', entries: dirEntries };
    }

    return null;
  }

  /** Delete a file via DELETE /contents. */
  public deleteContent(
    repo: RepoRecord,
    targetBranch: string | undefined,
    filePath: string,
    message: string,
    expectedSha: string,
  ): { commitSha: string } {
    const branch = targetBranch ?? repo.default_branch;
    const cleanPath = filePath.replace(/^\/+/, '');
    const bFiles = repo.branchFiles.get(branch);
    if (!bFiles || !bFiles.has(cleanPath)) {
      const err = new Error('File not found');
      (err as unknown as { statusCode: number }).statusCode = 404;
      throw err;
    }

    const current = bFiles.get(cleanPath)!;
    if (current.oid.toLowerCase() !== expectedSha.toLowerCase()) {
      const err = new Error('Stale sha');
      (err as unknown as { statusCode: number }).statusCode = 409;
      throw err;
    }

    bFiles.delete(cleanPath);

    const prevSha = repo.refs.get(`refs/heads/${branch}`);
    const parents = prevSha && prevSha !== '0'.repeat(40) ? [prevSha] : [];
    const { oid: treeSha } = hashGitObject('tree', Buffer.alloc(0));

    const nowIso = getNow();
    const nowSec = getUnixSeconds();
    const { oid: commitSha } = buildCommitObject(
      treeSha,
      parents,
      { name: repo.owner.name, email: repo.owner.email, date: nowSec },
      message,
    );

    const commitRec: CommitRecord = {
      sha: commitSha,
      message,
      author: { name: repo.owner.name, email: repo.owner.email, date: nowIso },
      committer: { name: repo.owner.name, email: repo.owner.email, date: nowIso },
      parents,
      treeSha,
    };

    const bCommits = repo.branchCommits.get(branch) ?? [];
    bCommits.unshift(commitRec);
    repo.branchCommits.set(branch, bCommits);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    repo.pushed_at = nowIso;
    repo.updated_at = nowIso;

    return { commitSha };
  }

  /** List commits on a branch. */
  public listCommits(repo: RepoRecord, targetBranchOrSha?: string): CommitRecord[] {
    const branch = targetBranchOrSha ?? repo.default_branch;
    const commits = repo.branchCommits.get(branch);
    if (commits) return commits;

    // If not a named branch, find branch whose tip equals targetBranchOrSha
    for (const [bName, bCommits] of repo.branchCommits.entries()) {
      const tip = repo.refs.get(`refs/heads/${bName}`);
      if (tip && tip.toLowerCase() === branch.toLowerCase()) {
        return bCommits;
      }
    }
    return [];
  }

  /** Create a label on a repo. */
  public createLabel(repo: RepoRecord, name: string, color: string, description: string | null = null): Label {
    const labelId = repo.nextLabelId++;
    const label: Label = {
      id: labelId,
      node_id: Buffer.from(`05:Label${labelId}`).toString('base64'),
      name,
      color,
      default: false,
      description,
    };
    repo.labels.set(name.toLowerCase(), label);
    return label;
  }

  /** Get a label on a repo. */
  public getLabel(repo: RepoRecord, name: string): Label | undefined {
    return repo.labels.get(name.toLowerCase());
  }

  /** Create an issue on a repo. Enforces label existence (throws 422 if unknown). */
  public createIssue(repo: RepoRecord, author: User, title: string, body: string = '', labelNames: string[] = []): Issue {
    const resolvedLabels: Label[] = [];
    if (labelNames.length > 0) {
      for (const lname of labelNames) {
        const lbl = this.getLabel(repo, lname);
        if (!lbl) {
          const err = new Error(`Label '${lname}' does not exist`);
          (err as unknown as { statusCode: number }).statusCode = 422;
          throw err;
        }
        resolvedLabels.push(lbl);
      }
    }

    const issueNumber = repo.nextIssueNumber++;
    const now = getNow();
    const issue: Issue = {
      id: issueNumber,
      node_id: btoa(`05:Issue${issueNumber}`),
      number: issueNumber,
      title,
      body,
      state: 'open',
      user: author,
      labels: resolvedLabels,
      comments: 0,
      created_at: now,
      updated_at: now,
      closed_at: null,
    };

    repo.issues.set(issueNumber, issue);
    repo.issueComments.set(issueNumber, []);
    (issue as unknown as { _jsonBuf?: Buffer })._jsonBuf = Buffer.from(`${JSON.stringify(issue)}\n`, 'utf8');
    return issue;
  }

  /** Get an issue by number. */
  public getIssue(repo: RepoRecord, number: number): Issue | undefined {
    return repo.issues.get(number);
  }

  /** Patch an issue (close/reopen, title, body). */
  public patchIssue(repo: RepoRecord, number: number, updates: Partial<{ title: string; body: string; state: 'open' | 'closed' }>): Issue {
    const issue = repo.issues.get(number);
    if (!issue) {
      const err = new Error('Issue not found');
      (err as unknown as { statusCode: number }).statusCode = 404;
      throw err;
    }

    const now = getNow();
    if (updates.title !== undefined) issue.title = updates.title;
    if (updates.body !== undefined) issue.body = updates.body;
    if (updates.state !== undefined) {
      issue.state = updates.state;
      issue.closed_at = updates.state === 'closed' ? now : null;
    }
    issue.updated_at = now;
    (issue as unknown as { _jsonBuf?: Buffer })._jsonBuf = Buffer.from(`${JSON.stringify(issue)}\n`, 'utf8');
    return issue;
  }

  /** List issues on a repo. */
  public listIssues(
    repo: RepoRecord,
    filter: { state?: 'open' | 'closed' | 'all'; sort?: 'created'; direction?: 'asc' | 'desc' } = {},
  ): Issue[] {
    const stateFilter = filter.state ?? 'open';
    const direction = filter.direction ?? 'desc';

    let issues = Array.from(repo.issues.values());
    if (stateFilter !== 'all') {
      issues = issues.filter((i) => i.state === stateFilter);
    }

    issues.sort((a, b) => {
      if (direction === 'asc') return a.number - b.number;
      return b.number - a.number;
    });

    return issues;
  }

  /** Add a comment to an issue. */
  public addComment(repo: RepoRecord, author: User, issueNumber: number, body: string): IssueComment {
    const issue = repo.issues.get(issueNumber);
    if (!issue) {
      const err = new Error('Issue not found');
      (err as unknown as { statusCode: number }).statusCode = 404;
      throw err;
    }

    const commentId = repo.nextCommentId++;
    const now = getNow();
    const comment: IssueComment = {
      id: commentId,
      node_id: Buffer.from(`012:IssueComment${commentId}`).toString('base64'),
      body,
      user: { ...author },
      created_at: now,
      updated_at: now,
    };

    const comments = repo.issueComments.get(issueNumber) ?? [];
    comments.push(comment);
    repo.issueComments.set(issueNumber, comments);
    issue.comments = comments.length;
    issue.updated_at = now;
    return comment;
  }

  /** List comments for an issue. */
  public listComments(repo: RepoRecord, issueNumber: number): IssueComment[] {
    return repo.issueComments.get(issueNumber) ?? [];
  }

  /** Create a pull request. */
  public createPull(repo: RepoRecord, author: User, title: string, headBranch: string, baseBranch: string, body: string = ''): PullRequest {
    const prNumber = repo.nextIssueNumber++;
    const now = getNow();

    const cleanHead = headBranch.replace('refs/heads/', '');
    const cleanBase = baseBranch.replace('refs/heads/', '');

    const headSha = repo.refs.get(`refs/heads/${cleanHead}`) ?? '0'.repeat(40);
    const baseSha = repo.refs.get(`refs/heads/${cleanBase}`) ?? '0'.repeat(40);

    const pr: PullRequest = {
      id: prNumber,
      node_id: Buffer.from(`011:PullRequest${prNumber}`).toString('base64'),
      number: prNumber,
      title,
      body,
      state: 'open',
      user: { ...author },
      head: {
        label: `${repo.owner.login}:${cleanHead}`,
        ref: cleanHead,
        sha: headSha,
        user: { ...author },
        repo: { name: repo.name, full_name: repo.full_name, owner: { ...repo.owner } },
      },
      base: {
        label: `${repo.owner.login}:${cleanBase}`,
        ref: cleanBase,
        sha: baseSha,
        user: { ...repo.owner },
        repo: { name: repo.name, full_name: repo.full_name, owner: { ...repo.owner } },
      },
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      mergeable: true,
      created_at: now,
      updated_at: now,
    };

    // Calculate changed files between head and base branch
    let baseFiles = repo.branchFiles.get(cleanBase);
    if (!baseFiles || baseFiles.size === 0) {
      baseFiles = this.extractFilesFromCommit(repo, baseSha);
    }
    let headFiles = repo.branchFiles.get(cleanHead);
    if (!headFiles || headFiles.size === 0) {
      headFiles = this.extractFilesFromCommit(repo, headSha);
    }
    const changedFiles: PullRequestFile[] = [];
    const changedFilesBaseSha = new Map<string, string>();

    for (const [path, hf] of headFiles.entries()) {
      const bf = baseFiles.get(path);
      const bOid = bf ? bf.oid : '0'.repeat(40);
      changedFilesBaseSha.set(path, bOid);

      if (!bf) {
        changedFiles.push({
          sha: hf.oid,
          filename: path,
          status: 'added',
          additions: 1,
          deletions: 0,
          changes: 1,
        });
      } else if (bf.oid !== hf.oid) {
        changedFiles.push({
          sha: hf.oid,
          filename: path,
          status: 'modified',
          additions: 1,
          deletions: 1,
          changes: 2,
        });
      }
    }

    pr.baseShaAtCreation = baseSha;
    pr.changedFilesBaseSha = changedFilesBaseSha;

    repo.pulls.set(prNumber, pr);
    repo.pullFiles.set(prNumber, changedFiles);
    return pr;
  }

  /** Get a pull request by number. */
  public getPull(repo: RepoRecord, number: number): PullRequest | undefined {
    return repo.pulls.get(number);
  }

  /** List pull requests on a repo. */
  public listPulls(repo: RepoRecord, filter: { state?: 'open' | 'closed' | 'all' } = {}): PullRequest[] {
    const stateFilter = filter.state ?? 'open';
    let pulls = Array.from(repo.pulls.values());
    if (stateFilter !== 'all') {
      pulls = pulls.filter((p) => p.state === stateFilter);
    }
    pulls.sort((a, b) => b.number - a.number);
    return pulls;
  }

  /** Get files changed in a pull request. */
  public getPullFiles(repo: RepoRecord, number: number): PullRequestFile[] {
    return repo.pullFiles.get(number) ?? [];
  }

  /** Merge a pull request using squash-merge. */
  public mergePull(repo: RepoRecord, number: number, commitMessage?: string): { sha: string; merged: boolean; message: string } {
    const pr = repo.pulls.get(number);
    if (!pr) {
      const err = new Error('Pull Request not found');
      (err as unknown as { statusCode: number }).statusCode = 404;
      throw err;
    }

    if (pr.merged || pr.state === 'closed') {
      const err = new Error('Pull Request is not mergeable');
      (err as unknown as { statusCode: number }).statusCode = 405;
      throw err;
    }

    const cleanHead = pr.head.ref;
    const cleanBase = pr.base.ref;

    const baseFiles = repo.branchFiles.get(cleanBase) ?? new Map<string, FileEntry>();
    const headFiles = repo.branchFiles.get(cleanHead) ?? new Map<string, FileEntry>();

    // Check for merge conflict
    if (pr.changedFilesBaseSha) {
      for (const [path, baseShaAtCreation] of pr.changedFilesBaseSha.entries()) {
        const currentBaseFile = baseFiles.get(path);
        const currentBaseSha = currentBaseFile ? currentBaseFile.oid : '0'.repeat(40);
        const headFile = headFiles.get(path);
        const headSha = headFile ? headFile.oid : '0'.repeat(40);

        if (currentBaseSha !== baseShaAtCreation && currentBaseSha !== headSha) {
          const err = new Error('Pull Request is not mergeable');
          (err as unknown as { statusCode: number }).statusCode = 405;
          throw err;
        }
      }
    }

    // Copy head files onto base branch
    for (const [path, file] of headFiles.entries()) {
      baseFiles.set(path, { ...file });
    }
    repo.branchFiles.set(cleanBase, baseFiles);

    // Create squash commit on base branch
    const prevBaseSha = repo.refs.get(`refs/heads/${cleanBase}`) ?? '0'.repeat(40);
    const parents = prevBaseSha && prevBaseSha !== '0'.repeat(40) ? [prevBaseSha] : [];
    const { oid: treeSha } = hashGitObject('tree', Buffer.from(`squash ${cleanBase}\0`, 'utf8'));

    const nowIso = getNow();
    const nowSec = getUnixSeconds();
    const finalMsg = commitMessage ?? `Merge pull request #${pr.number} from ${cleanHead}\n\n${pr.title}`;

    const { oid: mergeSha } = buildCommitObject(
      treeSha,
      parents,
      { name: repo.owner.name, email: repo.owner.email, date: nowSec },
      finalMsg,
    );

    const commitRec: CommitRecord = {
      sha: mergeSha,
      message: finalMsg,
      author: { name: repo.owner.name, email: repo.owner.email, date: nowIso },
      committer: { name: repo.owner.name, email: repo.owner.email, date: nowIso },
      parents,
      treeSha,
    };

    const baseCommits = repo.branchCommits.get(cleanBase) ?? [];
    baseCommits.unshift(commitRec);
    repo.branchCommits.set(cleanBase, baseCommits);

    repo.refs.set(`refs/heads/${cleanBase}`, mergeSha);
    repo.pushed_at = nowIso;
    repo.updated_at = nowIso;

    // Update PR record
    pr.merged = true;
    pr.state = 'closed';
    pr.merged_at = nowIso;
    pr.merge_commit_sha = mergeSha;
    pr.updated_at = nowIso;

    return {
      sha: mergeSha,
      merged: true,
      message: 'Pull Request successfully merged',
    };
  }

  /** Extract file map from a commit's git tree in repo.objects. */
  public extractFilesFromCommit(repo: RepoRecord, commitSha: string): Map<string, FileEntry> {
    const result = new Map<string, FileEntry>();
    if (!commitSha || commitSha === '0'.repeat(40)) return result;
    const commitObj = repo.objects.get(commitSha);
    if (!commitObj || commitObj.type !== 'commit') return result;
    const commit = parseCommit(commitObj.data);

    const walk = (treeSha: string, prefix: string) => {
      const treeObj = repo.objects.get(treeSha);
      if (!treeObj || treeObj.type !== 'tree') return;
      for (const entry of parseTree(treeObj.data)) {
        const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === '40000') {
          walk(entry.oid, fullPath);
        } else {
          const blob = repo.objects.get(entry.oid);
          result.set(fullPath, {
            path: fullPath,
            oid: entry.oid,
            content: blob ? Buffer.from(blob.data) : Buffer.alloc(0),
            size: blob ? blob.data.length : 0,
          });
        }
      }
    };

    walk(commit.tree, '');
    return result;
  }

  /** Find repository by Relay global ID or numeric database ID. */
  public findRepoByGlobalId(id: string): RepoRecord | undefined {
    for (const repo of this.repos.values()) {
      if (repo.node_id === id || String(repo.id) === id) return repo;
    }
    try {
      const decoded = Buffer.from(id, 'base64').toString('utf8');
      const match = decoded.match(/^010:Repository(\d+)$/);
      if (match) {
        const numId = parseInt(match[1], 10);
        for (const repo of this.repos.values()) {
          if (repo.id === numId) return repo;
        }
      }
    } catch {}
    return undefined;
  }

  /** Find issue across all repositories by Relay global ID. */
  public findIssueByGlobalId(id: string): { repo: RepoRecord; issue: Issue } | undefined {
    for (const repo of this.repos.values()) {
      for (const issue of repo.issues.values()) {
        if (issue.node_id === id) return { repo, issue };
      }
    }
    try {
      const decoded = Buffer.from(id, 'base64').toString('utf8');
      const match = decoded.match(/^05:Issue(\d+)$/);
      if (match) {
        const numId = parseInt(match[1], 10);
        for (const repo of this.repos.values()) {
          for (const issue of repo.issues.values()) {
            if (issue.id === numId) return { repo, issue };
          }
        }
      }
    } catch {}
    return undefined;
  }

  /** Find pull request across all repositories by Relay global ID. */
  public findPullByGlobalId(id: string): { repo: RepoRecord; pr: PullRequest } | undefined {
    for (const repo of this.repos.values()) {
      for (const pr of repo.pulls.values()) {
        if (pr.node_id === id) return { repo, pr };
      }
    }
    try {
      const decoded = Buffer.from(id, 'base64').toString('utf8');
      const match = decoded.match(/^011:PullRequest(\d+)$/);
      if (match) {
        const numId = parseInt(match[1], 10);
        for (const repo of this.repos.values()) {
          for (const pr of repo.pulls.values()) {
            if (pr.id === numId) return { repo, pr };
          }
        }
      }
    } catch {}
    return undefined;
  }
}

/** Global singleton store instance. */
export const store = new MemoryStore();
