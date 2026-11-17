// The small HTTP vocabulary the surfaces share: a parsed request and a described response.
// app.ts owns the socket; each surface is a pure function from (forge, request) to a response.

import type { IncomingHttpHeaders } from 'node:http';

export interface Req {
  method: string;
  /** Path segments after the surface's prefix, percent-decoded ('/' inside a segment stays split). */
  segments: string[];
  /** The full decoded path, for building absolute pagination URLs. */
  rawPath: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** The request's Host header: the origin the suite dialled, used for Link headers. */
  host: string;
}

export interface Res {
  status: number;
  json?: unknown;
  text?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

export function jsonRes(status: number, body: unknown, headers?: Record<string, string>): Res {
  return { status, json: body, headers };
}

export function notFound(message = 'Not Found'): Res {
  return { status: 404, json: { message } };
}

export function badRequest(message: string): Res {
  return { status: 400, json: { message } };
}

export function unprocessable(message: string): Res {
  return { status: 422, json: { message } };
}

/** Parse a JSON request body: an empty body is {}, malformed JSON is a 400 the caller returns. */
export function jsonBody(req: Req): { ok: true; value: Record<string, unknown> } | { ok: false; res: Res } {
  const text = req.body.toString('utf8').trim();
  if (text === '') return { ok: true, value: {} };
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, res: badRequest('Problems parsing JSON') };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, res: badRequest('Problems parsing JSON') };
  }
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
