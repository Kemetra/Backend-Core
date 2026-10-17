/**
 * Reads the raw envelope body of the Console tunnel (RT-632, OBS-3).
 *
 * Nest parses only JSON and urlencoded bodies, and the browser SDK sends a
 * string envelope as `text/plain`, so the body stream is still unread here.
 * The media type is checked first (a JSON or form body was already consumed
 * by Nest's parsers and is refused), then the byte cap is enforced both on
 * `Content-Length` and while streaming, so an oversized body is never
 * buffered whole.
 */
import {
  BadRequestException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import type { Request } from "express";

const ENVELOPE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "text/plain",
  "application/x-sentry-envelope",
  "application/octet-stream",
]);

function unsupported(): UnsupportedMediaTypeException {
  return new UnsupportedMediaTypeException({
    code: "unsupported_media_type",
    message: "Content type or encoding is not supported.",
  });
}

export function tooLarge(): PayloadTooLargeException {
  return new PayloadTooLargeException({
    code: "envelope_too_large",
    message: "Envelope is too large.",
  });
}

function headerValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value.join(",") : (value ?? "")).trim().toLowerCase();
}

/** Throws 415 unless the body is an uncompressed envelope media type (or untyped). */
export function assertEnvelopeMediaType(req: Pick<Request, "headers">): void {
  const mediaType = headerValue(req.headers["content-type"]).split(";")[0]!.trim();
  if (mediaType.length > 0 && !ENVELOPE_MEDIA_TYPES.has(mediaType)) throw unsupported();
  const encoding = headerValue(req.headers["content-encoding"]);
  if (encoding.length > 0 && encoding !== "identity") throw unsupported();
}

type BodyStream = Pick<Request, "headers" | "on" | "off" | "resume" | "readableEnded">;

/** Resolves the body bytes; rejects with 413 past `maxBytes`, 400 on an aborted stream. */
export function readEnvelopeBody(req: BodyStream, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.resume();
    return Promise.reject(tooLarge());
  }
  if (req.readableEnded) return Promise.resolve(Buffer.alloc(0));

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const cleanup = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total <= maxBytes) {
        chunks.push(chunk);
        return;
      }
      cleanup();
      req.resume();
      reject(tooLarge());
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks, total));
    };
    const onError = (): void => {
      cleanup();
      reject(new BadRequestException({ code: "envelope_malformed", message: "Request body could not be read." }));
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}
