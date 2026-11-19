# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/gomedz/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/gomedz/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Standalone, zero-dependency, ultra-fast GitHub-compatible git forge in Node 22 for make.fun bounty [github-core-clone-01](https://make.fun/bounty/github-core-clone-01).

Built with pure TypeScript, zero external runtime dependencies, and native implementations of:
- **Git Smart HTTP Protocol:** Git v2 protocol (`ls-refs`, `fetch` with shallow clone depth-1 and deepen) and v0 (`info/refs`, `git-receive-pack` with custom packfile unpacker and delta resolution).
- **GitHub REST API v3:** Repositories, base64 contents, issues, comments, labels, and squash-merge engine.
- **GitHub GraphQL v4:** Schema introspection (`Issue`, `PullRequest`, `Repository`, `SearchType`), queries, mutations, and batched execution.
- **Model Context Protocol (MCP):** JSON-RPC 2.0 at `/mcp` supporting tools `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, and `merge_pull_request`.

## Run

```bash
node --experimental-strip-types main.ts
```

Built for make.fun bounty: https://make.fun/bounty/github-core-clone-01
