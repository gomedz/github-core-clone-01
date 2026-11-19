// src/types.ts — Core data types for github-core-clone-01.

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
  avatar_url?: string;
  type?: string;
  site_admin?: boolean;
}

export interface Label {
  id: number;
  node_id: string;
  name: string;
  color: string;
  default?: boolean;
  description: string | null;
}

export interface IssueComment {
  id: number;
  node_id: string;
  body: string;
  user: User;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  user: User;
  labels: Label[];
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface PullRef {
  label: string;
  ref: string;
  sha: string;
  user?: User;
  repo?: Partial<RepoRecord>;
}

export interface PullRequest {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  user: User;
  head: PullRef;
  base: PullRef;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  mergeable: boolean;
  created_at: string;
  updated_at: string;
  // Conflict detection metadata
  baseShaAtCreation: string;
  changedFilesBaseSha: Map<string, string>;
}

export interface PullRequestFile {
  sha: string;
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
  oid: string;
}

export interface TreeEntry {
  mode: string;
  path: string;
  oid: string;
  type: GitObjectType;
}

export interface FileEntry {
  path: string;
  oid: string;
  content: Buffer;
  size: number;
}

export interface CommitRecord {
  sha: string;
  message: string;
  author: { name: string; email: string; date: string };
  committer: { name: string; email: string; date: string };
  parents: string[];
  treeSha: string;
}

export interface RepoRecord {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  owner: User;
  private: boolean;
  description: string | null;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  has_issues: boolean;
  // Git Storage
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // e.g. "refs/heads/main" -> commit SHA
  HEAD: string; // e.g. "ref: refs/heads/main"
  // Per-branch tracking of files and commits
  branchFiles: Map<string, Map<string, FileEntry>>; // branchName -> (path -> FileEntry)
  branchCommits: Map<string, CommitRecord[]>; // branchName -> CommitRecord[]
  // Issues & Pulls
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  issueComments: Map<number, IssueComment[]>;
  pulls: Map<number, PullRequest>;
  pullFiles: Map<number, PullRequestFile[]>;
  nextIssueNumber: number;
  nextCommentId: number;
  nextLabelId: number;
}
