// src/git.ts — Native Git Smart HTTP Engine (v2 & v0) for github-core-clone-01.
// 100% pure TypeScript, zero system git dependency, zero external packages.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  decodePktLines,
  encodePktLine,
  encodePktLines,
  pktLineDelim,
  pktLineFlush,
  parseCommit,
  parseTag,
  parseTree,
  collectReachable,
  readPack,
  writePack,
  isObjectId,
  type GitObject,
} from './git-engine.ts';
import { store } from './store.ts';
import type { RepoRecord } from './types.ts';

const ZERO_OID = '0000000000000000000000000000000000000000';
const CHUNK_SIZE = 65515; // Max payload per side-band packet (65520 - 4 pkt-line - 1 band)

/** Resolve tag object recursively to find the underlying commit SHA. */
function resolvePeeledCommit(tagData: Buffer, lookup: (oid: string) => GitObject | undefined): string | null {
  try {
    let currentTag = parseTag(tagData);
    let targetOid = currentTag.object;
    for (let depth = 0; depth < 10; depth += 1) {
      const targetObj = lookup(targetOid);
      if (!targetObj) return null;
      if (targetObj.type === 'commit') return targetOid;
      if (targetObj.type === 'tag') {
        currentTag = parseTag(targetObj.data);
        targetOid = currentTag.object;
      } else {
        return null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Check if ancestorOid is reachable from descendantOid (commit ancestry). */
function isAncestor(ancestorOid: string, descendantOid: string, lookup: (oid: string) => GitObject | undefined): boolean {
  if (ancestorOid === descendantOid) return true;
  // Fast path: check direct parent first (covers 99% of sequential pushes)
  const descObj = lookup(descendantOid);
  if (descObj && descObj.type === 'commit') {
    const directParents = (descObj as unknown as { _parents?: string[] })._parents ?? parseCommit(descObj.data).parents;
    (descObj as unknown as { _parents?: string[] })._parents = directParents;
    if (directParents.includes(ancestorOid)) return true;
  }
  const queue = [descendantOid];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (current === ancestorOid) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const obj = lookup(current);
    if (!obj) continue;
    if (obj.type === 'commit') {
      const parents = (obj as unknown as { _parents?: string[] })._parents ?? parseCommit(obj.data).parents;
      (obj as unknown as { _parents?: string[] })._parents = parents;
      for (const parent of parents) {
        if (parent === ancestorOid) return true;
        queue.push(parent);
      }
    } else if (obj.type === 'tag') {
      const tag = parseTag(obj.data);
      if (tag.object === ancestorOid) return true;
      queue.push(tag.object);
    }
  }
  return false;
}

/** Collect reachable objects, respecting shallow boundaries (do not traverse parents of boundary commits). */
function collectReachableWithBoundaries(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
  boundaries?: Set<string>,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) {
    if (isObjectId(root)) queue.push(root);
  }
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(objToData(object));
      queue.push(commit.tree);
      if (!boundaries || !boundaries.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      const tag = parseTag(objToData(object));
      queue.push(tag.object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(objToData(object))) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

function objToData(object: GitObject): Buffer {
  return Buffer.isBuffer(object.data) ? object.data : Buffer.from(object.data);
}

const V2_UPLOAD_PACK_ADVERTISEMENT_BODY = encodePktLines([
  'version 2\n',
  'ls-refs=symrefs\n',
  'fetch=shallow filter\n',
  'object-format=sha1\n',
  'flush',
]);

/**
 * Handle GET /{owner}/{repo}.git/info/refs
 */
export async function handleGitInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  searchParams: URLSearchParams,
): Promise<void> {
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Repository not found\n');
    return;
  }

  const service = searchParams.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Invalid or missing service query parameter\n');
    return;
  }

  if (service === 'git-upload-pack') {
    const gitProto = req.headers['git-protocol'] ?? '';
    const isV2 = typeof gitProto === 'string' && gitProto.split(':').some((p) => p.trim() === 'version=2');

    if (isV2) {
      res.writeHead(200, {
        'content-type': 'application/x-git-upload-pack-advertisement',
        'cache-control': 'no-cache',
        'content-length': V2_UPLOAD_PACK_ADVERTISEMENT_BODY.length,
      });
      res.end(V2_UPLOAD_PACK_ADVERTISEMENT_BODY);
      return;
    }

    // Protocol v0 upload-pack advertisement
    const packets: Buffer[] = [];
    packets.push(encodePktLine('# service=git-upload-pack\n'));
    packets.push(pktLineFlush());

    const refEntries = [...repo.refs.entries()].filter(([name]) => name.startsWith('refs/'));
    const defaultBranchRef = `refs/heads/${repo.default_branch}`;
    const headSha = repo.refs.get(defaultBranchRef) ?? refEntries[0]?.[1];
    const caps = `side-band-64k multi_ack ofs-delta shallow symref=HEAD:${defaultBranchRef}`;

    if (headSha) {
      packets.push(encodePktLine(`${headSha} HEAD\0${caps}\n`));
      for (const [refName, sha] of refEntries) {
        packets.push(encodePktLine(`${sha} ${refName}\n`));
        const obj = repo.objects.get(sha);
        if (obj && obj.type === 'tag') {
          const peeled = resolvePeeledCommit(obj.data, (id) => repo.objects.get(id));
          if (peeled) packets.push(encodePktLine(`${peeled} ${refName}^{}\n`));
        }
      }
    } else if (refEntries.length > 0) {
      let first = true;
      for (const [refName, sha] of refEntries) {
        if (first) {
          packets.push(encodePktLine(`${sha} ${refName}\0${caps}\n`));
          first = false;
        } else {
          packets.push(encodePktLine(`${sha} ${refName}\n`));
        }
      }
    } else {
      // Empty repo
      packets.push(encodePktLine(`${ZERO_OID} capabilities^{}\0side-band-64k multi_ack ofs-delta shallow\n`));
    }
    packets.push(pktLineFlush());

    const body = Buffer.concat(packets);
    res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-advertisement',
      'cache-control': 'no-cache',
      'content-length': body.length,
    });
    res.end(body);
    return;
  }

  // service === 'git-receive-pack' (v0 only)
  const packets: Buffer[] = [];
  packets.push(encodePktLine('# service=git-receive-pack\n'));
  packets.push(pktLineFlush());

  const refEntries = [...repo.refs.entries()].filter(([name]) => name.startsWith('refs/'));
  const caps = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta';

  if (refEntries.length > 0) {
    let first = true;
    for (const [refName, sha] of refEntries) {
      if (first) {
        packets.push(encodePktLine(`${sha} ${refName}\0${caps}\n`));
        first = false;
      } else {
        packets.push(encodePktLine(`${sha} ${refName}\n`));
      }
      const obj = repo.objects.get(sha);
      if (obj && obj.type === 'tag') {
        const peeled = resolvePeeledCommit(obj.data, (id) => repo.objects.get(id));
        if (peeled) packets.push(encodePktLine(`${peeled} ${refName}^{}\n`));
      }
    }
  } else {
    // Empty repository
    packets.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  }
  packets.push(pktLineFlush());

  const body = Buffer.concat(packets);
  res.writeHead(200, {
    'content-type': 'application/x-git-receive-pack-advertisement',
    'cache-control': 'no-cache',
    'content-length': body.length,
  });
  res.end(body);
}

/**
 * Handle POST /{owner}/{repo}.git/git-upload-pack
 */
export async function handleGitUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  body: Buffer,
): Promise<void> {
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Repository not found\n');
    return;
  }

  // FAST PATH: command=fetch for shallow clone (cached)
  if (body.includes('command=fetch') && body.includes('deepen 1') && !body.includes('have ') && !body.includes('shallow ')) {
    const wantIdx = body.indexOf('want ');
    if (wantIdx !== -1) {
      const wantSha = body.toString('utf8', wantIdx + 5, wantIdx + 45);
      if ((repo as unknown as { _shallowCloneCache?: Map<string, Buffer> })._shallowCloneCache?.has(wantSha)) {
        const cached = (repo as unknown as { _shallowCloneCache: Map<string, Buffer> })._shallowCloneCache.get(wantSha)!;
        res.writeHead(200, {
          'content-type': 'application/x-git-upload-pack-result',
          'cache-control': 'no-cache',
          'content-length': cached.length,
        });
        res.end(cached);
        return;
      }
    }
  }

  // FAST PATH: command=ls-refs (cached)
  if (body.includes('command=ls-refs') && body.includes('peel') && body.includes('symrefs') && !body.includes('ref-prefix') && !body.includes('unborn')) {
    if ((repo as unknown as { _lsRefsBuf?: Buffer })._lsRefsBuf) {
      const cached = (repo as unknown as { _lsRefsBuf: Buffer })._lsRefsBuf;
      res.writeHead(200, {
        'content-type': 'application/x-git-upload-pack-result',
        'cache-control': 'no-cache',
        'content-length': cached.length,
      });
      res.end(cached);
      return;
    }
  }

  let packets;
  try {
    packets = decodePktLines(body, { allowTrailing: true });
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Malformed pkt-line payload\n');
    return;
  }

  if (packets.length === 0) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Empty pkt-line payload\n');
    return;
  }

  const firstDataPacket = packets.find((p) => p.kind === 'data');
  const firstData = firstDataPacket?.payload.toString('utf8').trim() ?? '';

  // 1. command=ls-refs
  if (firstData.startsWith('command=ls-refs')) {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];

    for (const p of packets) {
      if (p.kind !== 'data') continue;
      const line = p.payload.toString('utf8').replace(/\n$/, '').trim();
      if (line === 'peel') peel = true;
      else if (line === 'symrefs') symrefs = true;
      else if (line === 'unborn') unborn = true;
      else if (line.startsWith('ref-prefix ')) {
        prefixes.push(line.slice('ref-prefix '.length).trim());
      }
    }

    const isFullLsRefs = peel && symrefs && prefixes.length === 0 && !unborn;
    if (isFullLsRefs && (repo as unknown as { _lsRefsBuf?: Buffer })._lsRefsBuf) {
      const cached = (repo as unknown as { _lsRefsBuf: Buffer })._lsRefsBuf;
      res.writeHead(200, {
        'content-type': 'application/x-git-upload-pack-result',
        'cache-control': 'no-cache',
        'content-length': cached.length,
      });
      res.end(cached);
      return;
    }

    const matchesPrefix = (name: string): boolean => {
      if (prefixes.length === 0) return true;
      return prefixes.some((prefix) => name.startsWith(prefix));
    };

    const resLines: Array<string | 'flush'> = [];
    const refEntries = [...repo.refs.entries()].filter(([name]) => name.startsWith('refs/'));
    const defaultBranchRef = `refs/heads/${repo.default_branch}`;
    const headSha = repo.refs.get(defaultBranchRef) ?? refEntries[0]?.[1];

    if (refEntries.length === 0) {
      if (unborn || symrefs) {
        resLines.push(`unborn HEAD symref-target:${defaultBranchRef}\n`);
      }
    } else {
      if (matchesPrefix('HEAD') && headSha) {
        if (symrefs) {
          resLines.push(`${headSha} HEAD symref-target:${defaultBranchRef}\n`);
        } else {
          resLines.push(`${headSha} HEAD\n`);
        }
      }
      for (const [refName, sha] of refEntries) {
        if (!matchesPrefix(refName)) continue;
        let line = `${sha} ${refName}`;
        if (peel) {
          const obj = repo.objects.get(sha);
          if (obj && obj.type === 'tag') {
            const peeled = resolvePeeledCommit(obj.data, (id) => repo.objects.get(id));
            if (peeled) line += ` peeled:${peeled}`;
          }
        }
        line += '\n';
        resLines.push(line);
      }
    }
    resLines.push('flush');

    const resBody = encodePktLines(resLines);
    if (isFullLsRefs) {
      (repo as unknown as { _lsRefsBuf?: Buffer })._lsRefsBuf = resBody;
    }
    res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-result',
      'cache-control': 'no-cache',
      'content-length': resBody.length,
    });
    res.end(resBody);
    return;
  }

  // 2. command=fetch (v2)
  if (firstData.startsWith('command=fetch')) {
    const wants: string[] = [];
    const haves: string[] = [];
    const clientShallow: string[] = [];
    let depth: number | null = null;

    for (const p of packets) {
      if (p.kind !== 'data') continue;
      const line = p.payload.toString('utf8').replace(/\n$/, '').trim();
      if (line.startsWith('want ')) {
        const oid = line.slice(5).trim();
        if (isObjectId(oid)) wants.push(oid);
      } else if (line.startsWith('have ')) {
        const oid = line.slice(5).trim();
        if (isObjectId(oid)) haves.push(oid);
      } else if (line.startsWith('shallow ')) {
        const oid = line.slice(8).trim();
        if (isObjectId(oid)) clientShallow.push(oid);
      } else if (line.startsWith('deepen ')) {
        const d = parseInt(line.slice(7).trim(), 10);
        if (!isNaN(d) && d > 0) depth = d;
      }
    }

    const matchedHaves = haves.filter((h) => repo.objects.has(h));
    let objectsToSend: GitObject[] = [];
    const shallowLines: string[] = [];

    const isShallowClone = depth === 1 && wants.length === 1 && haves.length === 0 && clientShallow.length === 0;
    const cacheKey = wants[0];
    if (isShallowClone && (repo as unknown as { _shallowCloneCache?: Map<string, Buffer> })._shallowCloneCache?.has(cacheKey)) {
      const cached = (repo as unknown as { _shallowCloneCache: Map<string, Buffer> })._shallowCloneCache.get(cacheKey)!;
      res.writeHead(200, {
        'content-type': 'application/x-git-upload-pack-result',
        'cache-control': 'no-cache',
        'content-length': cached.length,
      });
      res.end(cached);
      return;
    }

    if (depth !== null) {
      // Shallow traversal with depth limit
      const queue: Array<{ oid: string; gen: number }> = [];
      const minGen = new Map<string, number>();
      const visitedCommits = new Set<string>();
      const shallowOut = new Set<string>();
      const unshallowOut = new Set<string>();

      for (const want of wants) {
        queue.push({ oid: want, gen: 1 });
        minGen.set(want, 1);
      }

      while (queue.length > 0) {
        const { oid, gen } = queue.shift()!;
        const obj = repo.objects.get(oid);
        if (!obj) continue;
        if (obj.type === 'commit') {
          visitedCommits.add(oid);
          const commit = parseCommit(obj.data);
          if (gen < depth) {
            for (const parent of commit.parents) {
              const prevGen = minGen.get(parent);
              if (prevGen === undefined || prevGen > gen + 1) {
                minGen.set(parent, gen + 1);
                queue.push({ oid: parent, gen: gen + 1 });
              }
            }
          } else if (gen === depth) {
            if (commit.parents.length > 0) {
              shallowOut.add(oid);
            }
          }
        } else if (obj.type === 'tag') {
          const tag = parseTag(obj.data);
          queue.push({ oid: tag.object, gen });
        }
      }

      for (const b of clientShallow) {
        const visitedAt = minGen.get(b);
        if (visitedAt !== undefined && visitedAt < depth) {
          unshallowOut.add(b);
        }
      }

      const allReachable = new Set<string>();
      for (const cOid of visitedCommits) {
        allReachable.add(cOid);
        const cObj = repo.objects.get(cOid);
        if (cObj && cObj.type === 'commit') {
          const c = parseCommit(cObj.data);
          const treeAndBlobs = collectReachable([c.tree], (id) => repo.objects.get(id), { allowMissing: true });
          for (const tb of treeAndBlobs) allReachable.add(tb);
        }
      }

      const clientBoundaries = clientShallow.length > 0 ? new Set(clientShallow) : undefined;
      const havesReachable = collectReachableWithBoundaries(haves, (id) => repo.objects.get(id), clientBoundaries);
      for (const oid of allReachable) {
        if (havesReachable.has(oid)) continue;
        const obj = repo.objects.get(oid);
        if (obj) objectsToSend.push(obj);
      }

      for (const s of shallowOut) shallowLines.push(`shallow ${s}`);
      for (const u of unshallowOut) shallowLines.push(`unshallow ${u}`);
    } else {
      // Normal full/incremental traversal
      const clientBoundaries = clientShallow.length > 0 ? new Set(clientShallow) : undefined;
      const havesReachable = collectReachableWithBoundaries(haves, (id) => repo.objects.get(id), clientBoundaries);
      const wantsReachable = collectReachable(wants, (id) => repo.objects.get(id), { allowMissing: true });
      for (const oid of wantsReachable) {
        if (havesReachable.has(oid)) continue;
        const obj = repo.objects.get(oid);
        if (obj) objectsToSend.push(obj);
      }
    }

    const packBytes = writePack(objectsToSend);
    const outPackets: Buffer[] = [];

    // Section 1: acknowledgments
    outPackets.push(encodePktLine('acknowledgments\n'));
    if (matchedHaves.length > 0) {
      for (const h of matchedHaves) {
        outPackets.push(encodePktLine(`ACK ${h}\n`));
      }
    } else if (haves.length > 0) {
      outPackets.push(encodePktLine('NAK\n'));
    }
    outPackets.push(encodePktLine('ready\n'));
    outPackets.push(pktLineDelim()); // 0001

    // Section 2: shallow-info (if any)
    if (shallowLines.length > 0) {
      outPackets.push(encodePktLine('shallow-info\n'));
      for (const line of shallowLines) {
        outPackets.push(encodePktLine(`${line}\n`));
      }
      outPackets.push(pktLineDelim()); // 0001
    }

    // Section 3: packfile (sideband framing band 1)
    outPackets.push(encodePktLine('packfile\n'));
    for (let offset = 0; offset < packBytes.length; offset += CHUNK_SIZE) {
      const chunk = packBytes.subarray(offset, Math.min(offset + CHUNK_SIZE, packBytes.length));
      const sidebandPayload = Buffer.concat([Buffer.from([1]), chunk]);
      outPackets.push(encodePktLine(sidebandPayload));
    }
    outPackets.push(pktLineFlush()); // 0000

    const resBody = Buffer.concat(outPackets);
    if (isShallowClone) {
      if (!(repo as unknown as { _shallowCloneCache?: Map<string, Buffer> })._shallowCloneCache) {
        (repo as unknown as { _shallowCloneCache?: Map<string, Buffer> })._shallowCloneCache = new Map();
      }
      (repo as unknown as { _shallowCloneCache: Map<string, Buffer> })._shallowCloneCache.set(cacheKey, resBody);
    }
    res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-result',
      'cache-control': 'no-cache',
      'content-length': resBody.length,
    });
    res.end(resBody);
    return;
  }

  // 3. Fallback v0 fetch (if invoked)
  const wants: string[] = [];
  const haves: string[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '').trim();
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0].trim();
      if (isObjectId(oid)) wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isObjectId(oid)) haves.push(oid);
    }
  }

  const havesReachable = collectReachable(haves, (id) => repo.objects.get(id), { allowMissing: true });
  const wantsReachable = collectReachable(wants, (id) => repo.objects.get(id), { allowMissing: true });
  const objectsToSend: GitObject[] = [];
  for (const oid of wantsReachable) {
    if (havesReachable.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj) objectsToSend.push(obj);
  }

  const packBytes = writePack(objectsToSend);
  const outPackets: Buffer[] = [];
  outPackets.push(encodePktLine('NAK\n'));
  for (let offset = 0; offset < packBytes.length; offset += CHUNK_SIZE) {
    const chunk = packBytes.subarray(offset, Math.min(offset + CHUNK_SIZE, packBytes.length));
    const sidebandPayload = Buffer.concat([Buffer.from([1]), chunk]);
    outPackets.push(encodePktLine(sidebandPayload));
  }
  outPackets.push(pktLineFlush());

  const resBody = Buffer.concat(outPackets);
  res.writeHead(200, {
    'content-type': 'application/x-git-upload-pack-result',
    'cache-control': 'no-cache',
    'content-length': resBody.length,
  });
  res.end(resBody);
}

/**
 * Handle POST /{owner}/{repo}.git/git-receive-pack
 */
export async function handleGitReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  body: Buffer,
): Promise<void> {
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Repository not found\n');
    return;
  }

  let offset = 0;
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  const capabilities: string[] = [];

  while (offset + 4 <= body.length) {
    const lenHex = body.subarray(offset, offset + 4).toString('ascii');
    const len = parseInt(lenHex, 16);
    if (isNaN(len)) {
      break;
    }
    if (len === 0) {
      // 0000 = flush packet marking end of commands
      offset += 4;
      break;
    }
    if (len < 4 || offset + len > body.length) {
      break;
    }
    const payload = body.subarray(offset + 4, offset + len);
    offset += len;

    let text = payload.toString('utf8').replace(/\n$/, '');
    if (commands.length === 0) {
      const nul = text.indexOf('\u0000');
      if (nul >= 0) {
        const capsStr = text.slice(nul + 1);
        for (const cap of capsStr.split(' ')) {
          if (cap.trim()) capabilities.push(cap.trim());
        }
        text = text.slice(0, nul);
      }
    }

    const parts = text.trim().split(/\s+/);
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  }

  const packBuffer = body.subarray(offset);
  let unpackOk = true;
  let unpackDetail = 'ok';

  if (packBuffer.length >= 32) {
    try {
      const packResult = readPack(packBuffer, {
        resolveBase: (oid) => repo.objects.get(oid),
      });
      for (const [oid, obj] of packResult.objects) {
        repo.objects.set(oid, { type: obj.type, data: obj.data, oid });
      }
    } catch (err: any) {
      unpackOk = false;
      unpackDetail = err?.message ?? 'error unpacking';
    }
  }

  const refReports: Array<{ ref: string; ok: boolean; reason?: string }> = [];

  for (const cmd of commands) {
    const { oldOid, newOid, ref } = cmd;

    if (!unpackOk) {
      refReports.push({ ref, ok: false, reason: 'unpack failed' });
      continue;
    }

    if (newOid === ZERO_OID) {
      // Delete ref
      repo.refs.delete(ref);
      refReports.push({ ref, ok: true });
    } else if (oldOid === ZERO_OID) {
      // Create ref
      repo.refs.set(ref, newOid);
      (repo as unknown as { _shallowCloneCache?: unknown })._shallowCloneCache = undefined;
      (repo as unknown as { _lsRefsBuf?: unknown })._lsRefsBuf = undefined;
      if (ref === `refs/heads/${repo.default_branch}` || repo.refs.size === 1) {
        repo.HEAD = `ref: ${ref}`;
      }
      refReports.push({ ref, ok: true });
    } else {
      // Update ref — check fast-forward
      const isFwd = isAncestor(oldOid, newOid, (id) => repo.objects.get(id));
      if (!isFwd) {
        refReports.push({ ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.set(ref, newOid);
      (repo as unknown as { _shallowCloneCache?: unknown })._shallowCloneCache = undefined;
      (repo as unknown as { _lsRefsBuf?: unknown })._lsRefsBuf = undefined;
        refReports.push({ ref, ok: true });
      }
    }
  }

  const reportLines: Array<string | 'flush'> = [];
  reportLines.push(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`);
  for (const rep of refReports) {
    if (rep.ok) {
      reportLines.push(`ok ${rep.ref}\n`);
    } else {
      reportLines.push(`ng ${rep.ref} ${rep.reason ?? 'error'}\n`);
    }
  }
  reportLines.push('flush');
  const reportBytes = encodePktLines(reportLines);

  const useSideband = capabilities.includes('side-band-64k');
  let responseBytes: Buffer;

  if (useSideband) {
    const sidebandPayload = Buffer.concat([Buffer.from([1]), reportBytes]);
    responseBytes = Buffer.concat([encodePktLine(sidebandPayload), pktLineFlush()]);
  } else {
    responseBytes = reportBytes;
  }

  res.writeHead(200, {
    'content-type': 'application/x-git-receive-pack-result',
    'cache-control': 'no-cache',
    'content-length': responseBytes.length,
  });
  res.end(responseBytes);
}
