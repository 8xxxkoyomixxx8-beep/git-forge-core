// Git smart HTTP: protocol v2 and v0 upload-pack (advertisement, ls-refs, fetch with shallow
// support) and v0 receive-pack (push with report-status), served from the forge's own object
// store. Packs are written as plain objects (no deltas — the suite's client resolves deltas but
// never requires them) and read with full OFS/REF delta resolution, so anything a conforming
// client pushes is stored verbatim.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  Forge,
  ZERO_OID,
  hashObject,
  isOid,
  parseCommit,
  parseTag,
  type ObjType,
  type RepoRec,
  type StoredObject,
} from './store.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'forge/1.0';
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// ------------------------------------------------------------------------------------------------
// pkt-line
// ------------------------------------------------------------------------------------------------

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Parse pkt-lines from `offset`; stops at the first malformed header and reports where. */
function parsePackets(buffer: Buffer, offset: number): { packets: Packet[]; next: number; ok: boolean } {
  const packets: Packet[] = [];
  let at = offset;
  while (at + 4 <= buffer.length) {
    const header = buffer.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) return { packets, next: at, ok: false };
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      at += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end' });
      at += 4;
      continue;
    }
    if (length < 4 || at + length > buffer.length) return { packets, next: at, ok: false };
    packets.push({ kind: 'data', payload: buffer.subarray(at + 4, at + length) });
    at += length;
  }
  return { packets, next: at, ok: at === buffer.length };
}

/** Split a request body into its pkt-line packets and the raw remainder (a push's packfile). */
function splitBody(body: Buffer): { packets: Packet[]; rest: Buffer; ok: boolean } {
  const parsed = parsePackets(body, 0);
  return { packets: parsed.packets, rest: body.subarray(parsed.next), ok: parsed.ok };
}

// ------------------------------------------------------------------------------------------------
// packfiles
// ------------------------------------------------------------------------------------------------

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A version-2 pack of plain objects, with its SHA-1 trailer. */
export function writePack(objects: readonly StoredObject[]): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Apply a git delta to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

/**
 * Read a pack into the store, resolving OFS/REF deltas. Answers an error string, or null when the
 * pack was structurally sound, checksummed, and every object stored.
 */
export function readPackInto(forge: Forge, pack: Buffer): string | null {
  try {
    if (pack.length < 32) return 'pack too short';
    if (pack.subarray(0, 4).toString('ascii') !== 'PACK') return 'bad pack header';
    const version = pack.readUInt32BE(4);
    if (version !== 2 && version !== 3) return `unsupported pack version ${version}`;
    const count = pack.readUInt32BE(8);
    const trailerStart = pack.length - 20;
    const trailer = pack.subarray(trailerStart).toString('hex');
    const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
    if (trailer !== computed) return 'pack checksum mismatch';

    interface Raw {
      offset: number;
      typeCode: number;
      data: Buffer;
      baseOffset?: number;
      baseOid?: string;
    }
    const raw: Raw[] = [];
    const byOffset = new Map<number, Raw>();
    let offset = 12;
    for (let index = 0; index < count; index += 1) {
      const entryOffset = offset;
      let byte = pack[offset] as number;
      offset += 1;
      const typeCode = (byte >> 4) & 0x07;
      let size = byte & 0x0f;
      let shift = 4;
      while (byte & 0x80) {
        byte = pack[offset] as number;
        offset += 1;
        size += (byte & 0x7f) * 2 ** shift;
        shift += 7;
      }
      const entry: Raw = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
      if (typeCode === 6) {
        let b = pack[offset] as number;
        offset += 1;
        let value = b & 0x7f;
        while (b & 0x80) {
          b = pack[offset] as number;
          offset += 1;
          value = (value + 1) * 128 + (b & 0x7f);
        }
        entry.baseOffset = entryOffset - value;
      } else if (typeCode === 7) {
        entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
        offset += 20;
      } else if (!CODE_TYPE[typeCode]) {
        return `unknown pack type code ${typeCode}`;
      }
      const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as {
        buffer: Buffer;
        engine: { bytesWritten: number };
      };
      if (inflated.buffer.length !== size) return 'pack entry size mismatch';
      entry.data = inflated.buffer;
      offset += inflated.engine.bytesWritten;
      raw.push(entry);
      byOffset.set(entryOffset, entry);
    }
    if (offset !== trailerStart) return 'pack has trailing bytes';

    const resolved = new Map<string, StoredObject>();
    const resolveEntry = (entry: Raw, seen: Set<number>): StoredObject => {
      if (seen.has(entry.offset)) throw new Error('delta cycle');
      seen.add(entry.offset);
      if (entry.typeCode === 6 || entry.typeCode === 7) {
        let base: StoredObject | undefined;
        if (entry.typeCode === 6) {
          const baseEntry = byOffset.get(entry.baseOffset as number);
          if (!baseEntry) throw new Error('ofs-delta base missing');
          base = resolveEntry(baseEntry, seen);
        } else {
          base = resolved.get(entry.baseOid as string) ?? forge.getObject(entry.baseOid as string);
          if (!base) throw new Error('ref-delta base missing');
        }
        return { type: base.type, data: applyDelta(base.data, entry.data) };
      }
      return { type: CODE_TYPE[entry.typeCode] as ObjType, data: entry.data };
    };
    for (const entry of raw) {
      const object = resolveEntry(entry, new Set());
      const oid = hashObject(object.type, object.data);
      resolved.set(oid, object);
      forge.putObject(object.type, object.data);
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ------------------------------------------------------------------------------------------------
// advertisements
// ------------------------------------------------------------------------------------------------

const UPLOAD_CAPS_V0 = `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=${AGENT}`;
const RECEIVE_CAPS_V0 = `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;

function sortedRefs(repo: RepoRec): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The oid a tag peels to (its commit), or null. */
function peeledOf(forge: Forge, oid: string): string | null {
  const object = forge.getObject(oid);
  if (!object || object.type !== 'tag') return null;
  return forge.peelToCommit(oid);
}

function v0Advertisement(forge: Forge, repo: RepoRec, service: string): Buffer {
  const caps = service === 'git-upload-pack' ? `${UPLOAD_CAPS_V0} symref=HEAD:refs/heads/${repo.defaultBranch}` : RECEIVE_CAPS_V0;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? (refs[0] as [string, string])[1];
    let first = true;
    const lines: Array<[string, string]> = [['HEAD', headOid], ...refs];
    for (const [name, oid] of lines) {
      parts.push(pkt(first ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`));
      first = false;
      const peeled = peeledOf(forge, oid);
      if (peeled !== null && name.startsWith('refs/tags/')) parts.push(pkt(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pkt('version 2\n'),
    pkt(`agent=${AGENT}\n`),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow\n'),
    pkt('object-format=sha1\n'),
    FLUSH,
  ]);
}

export function handleInfoRefs(forge: Forge, repo: RepoRec, service: string, v2Requested: boolean): GitResponse {
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && v2Requested) {
    return { status: 200, contentType, body: v2Advertisement() };
  }
  return { status: 200, contentType, body: v0Advertisement(forge, repo, service) };
}

// ------------------------------------------------------------------------------------------------
// ls-refs (protocol v2)
// ------------------------------------------------------------------------------------------------

function handleLsRefs(forge: Forge, repo: RepoRec, packets: Packet[]): GitResponse {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!pastDelim) continue;
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (matches('HEAD')) {
    const suffix = symrefs ? ` symref-target:${headTarget}` : '';
    if (headOid !== undefined) parts.push(pkt(`${headOid} HEAD${suffix}\n`));
    else if (unborn) parts.push(pkt(`unborn HEAD${suffix}\n`));
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peeledOf(forge, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    parts.push(pkt(`${line}\n`));
  }
  parts.push(FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

// ------------------------------------------------------------------------------------------------
// fetch (protocol v2 and v0)
// ------------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  clientShallow: string[];
  depth: number;
}

function parseFetchArgs(packets: Packet[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], clientShallow: [], depth: Number.POSITIVE_INFINITY };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0] as string;
      if (isOid(oid)) args.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isOid(oid)) args.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isOid(oid)) args.clientShallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const value = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(value) && value > 0) args.depth = value;
    }
  }
  return args;
}

interface FetchSelection {
  send: StoredObject[];
  shallow: string[];
  unshallow: string[];
}

/**
 * The objects a fetch delivers: the wants' closure cut at `depth` commit generations, minus what
 * the haves already cover — where the client's own shallow boundary cuts the haves' closure too
 * (a shallow-held commit's parents are exactly what the client does not have).
 */
function selectFetch(forge: Forge, args: FetchArgs): FetchSelection {
  const depthOf = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  for (const want of args.wants) {
    const object = forge.getObject(want);
    if (!object) continue;
    queue.push([want, object.type === 'commit' ? 1 : 0]);
  }
  let head = 0;
  while (head < queue.length) {
    const [oid, depth] = queue[head++] as [string, number];
    const known = depthOf.get(oid);
    if (known !== undefined && known <= depth) continue;
    depthOf.set(oid, depth);
    // Beyond the depth cut an object is only recorded — so the boundary stays known and a later,
    // shallower path can still claim it — but never expanded: a depth-1 clone of a long history
    // then walks the tip commit and its tree instead of every ancestor.
    if (depth > args.depth) continue;
    const object = forge.getObject(oid);
    if (!object) continue;
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push([commit.tree, depth]);
      for (const parent of commit.parents) queue.push([parent, depth + 1]);
    } else if (object.type === 'tag') {
      queue.push([parseTag(object.data).object, depth]);
    } else if (object.type === 'tree') {
      for (const entry of parseTreeSafe(forge, oid)) queue.push([entry, depth]);
    }
  }
  const inGraph = new Set<string>();
  for (const [oid, depth] of depthOf) if (depth <= args.depth) inGraph.add(oid);

  const shallowBoundary = new Set(args.clientShallow);
  const held = new Set<string>();
  const heldQueue: string[] = [...args.haves];
  while (heldQueue.length) {
    const oid = heldQueue.pop() as string;
    if (held.has(oid)) continue;
    const object = forge.getObject(oid);
    if (!object) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      heldQueue.push(commit.tree);
      if (!shallowBoundary.has(oid)) heldQueue.push(...commit.parents);
    } else if (object.type === 'tag') {
      heldQueue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTreeSafe(forge, oid)) heldQueue.push(entry);
    }
  }

  const send: StoredObject[] = [];
  for (const oid of inGraph) {
    if (held.has(oid)) continue;
    const object = forge.getObject(oid);
    if (object) send.push(object);
  }
  const shallow: string[] = [];
  if (Number.isFinite(args.depth)) {
    for (const oid of inGraph) {
      if (depthOf.get(oid) !== args.depth) continue;
      const object = forge.getObject(oid);
      if (object && object.type === 'commit' && parseCommit(object.data).parents.length > 0) shallow.push(oid);
    }
  }
  const unshallow: string[] = [];
  for (const oid of args.clientShallow) {
    const depth = depthOf.get(oid);
    if (depth !== undefined && depth < args.depth && inGraph.has(oid)) unshallow.push(oid);
  }
  return { send, shallow, unshallow };
}

function parseTreeSafe(forge: Forge, treeOid: string): string[] {
  const object = forge.getObject(treeOid);
  if (!object || object.type !== 'tree') return [];
  const out: string[] = [];
  let offset = 0;
  const data = object.data;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('ascii');
    if (mode !== '160000') out.push(data.subarray(nul + 1, nul + 21).toString('hex'));
    offset = nul + 21;
  }
  return out;
}

/** Pack bytes as sideband band-1 packets (payload at most 65516 bytes including the band byte). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let at = 0; at < pack.length; at += CHUNK) {
    parts.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(at, at + CHUNK)])));
  }
  return parts;
}

function handleFetchV2(forge: Forge, repo: RepoRec, packets: Packet[]): GitResponse {
  const args = parseFetchArgs(packets);
  const selection = selectFetch(forge, args);
  const parts: Buffer[] = [];
  parts.push(pkt('acknowledgments\n'));
  const common = args.haves.filter((oid) => forge.getObject(oid) !== undefined);
  if (common.length === 0) parts.push(pkt('NAK\n'));
  else for (const oid of common) parts.push(pkt(`ACK ${oid}\n`));
  parts.push(FLUSH);
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  if (selection.send.length > 0) {
    parts.push(pkt('packfile\n'));
    parts.push(...sidebandPackets(writePack(selection.send)));
    parts.push(FLUSH);
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function handleFetchV0(forge: Forge, repo: RepoRec, packets: Packet[]): GitResponse {
  const args = parseFetchArgs(packets);
  const selection = selectFetch(forge, args);
  const parts: Buffer[] = [];
  for (const oid of selection.shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  const common = args.haves.filter((oid) => forge.getObject(oid) !== undefined);
  if (common.length === 0) parts.push(pkt('NAK\n'));
  else parts.push(pkt(`ACK ${common[0]}\n`));
  if (selection.send.length > 0) parts.push(...sidebandPackets(writePack(selection.send)));
  parts.push(FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

export function handleUploadPack(forge: Forge, repo: RepoRec, body: Buffer, v2: boolean): GitResponse {
  const { packets, ok } = splitBody(body);
  if (!ok || packets.length === 0) {
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from('invalid pkt-line request\n') };
  }
  const first = packets[0];
  const commandLine = first && first.kind === 'data' ? first.payload.toString('utf8').replace(/\n$/, '') : '';
  if (v2) {
    if (commandLine === 'command=ls-refs') return handleLsRefs(forge, repo, packets);
    if (commandLine === 'command=fetch') return handleFetchV2(forge, repo, packets);
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from('unknown v2 command\n') };
  }
  return handleFetchV0(forge, repo, packets);
}

// ------------------------------------------------------------------------------------------------
// receive-pack (protocol v0)
// ------------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(forge: Forge, repo: RepoRec, body: Buffer): GitResponse {
  // The pkt-line parser stops where the packfile begins ('PACK' is not a hex header), so a valid
  // push is recognised by its flush packet, not by a whole-body parse.
  const { packets, rest } = splitBody(body);
  const commands: PushCommand[] = [];
  let sideband = false;
  let sawFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      const caps = line.slice(nul + 1);
      if (caps.split(' ').includes('side-band-64k')) sideband = true;
      line = line.slice(0, nul);
    }
    const fields = line.split(' ');
    if (fields.length === 3 && isOid(fields[0] as string) && isOid(fields[1] as string)) {
      commands.push({ oldOid: fields[0] as string, newOid: fields[1] as string, ref: fields[2] as string });
    }
  }
  if (!sawFlush) {
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from('invalid push request\n') };
  }

  let unpackError: string | null = null;
  if (rest.length > 0) unpackError = readPackInto(forge, rest);

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    results.push(applyPushCommand(forge, repo, command, unpackError));
  }

  const report: Buffer[] = [];
  report.push(pkt(unpackError === null ? 'unpack ok\n' : `unpack error ${unpackError}\n`));
  for (const result of results) {
    report.push(pkt(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  report.push(FLUSH);
  const reportBytes = Buffer.concat(report);
  const bodyOut = sideband ? Buffer.concat([...sidebandPackets(reportBytes), FLUSH]) : reportBytes;
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: bodyOut };
}

function applyPushCommand(
  forge: Forge,
  repo: RepoRec,
  command: PushCommand,
  unpackError: string | null,
): { ref: string; ok: boolean; reason: string } {
  const fail = (reason: string) => ({ ref: command.ref, ok: false, reason });
  if (!command.ref.startsWith('refs/') || command.ref.includes('..') || command.ref.includes(' ')) {
    return fail('invalid ref name');
  }
  if (unpackError !== null && command.newOid !== ZERO_OID) return fail('unpack failed');
  const current = repo.refs.get(command.ref) ?? ZERO_OID;

  if (command.newOid === ZERO_OID) {
    // A delete.
    if (current === ZERO_OID) return fail('reference not found');
    if (command.oldOid !== current) return fail('stale info');
    repo.refs.delete(command.ref);
    return { ref: command.ref, ok: true, reason: '' };
  }

  const object = forge.getObject(command.newOid);
  if (!object) return fail('invalid object');
  if (command.ref.startsWith('refs/heads/') && object.type !== 'commit') return fail('invalid object');
  if (command.ref.startsWith('refs/tags/') && object.type !== 'commit' && object.type !== 'tag') return fail('invalid object');

  if (current !== ZERO_OID) {
    if (command.oldOid !== current) return fail('stale info');
    if (command.newOid !== current && !forge.isAncestor(current, command.newOid)) return fail('non-fast-forward');
  } else if (command.oldOid !== ZERO_OID) {
    return fail('stale info');
  }
  repo.refs.set(command.ref, command.newOid);
  return { ref: command.ref, ok: true, reason: '' };
}
