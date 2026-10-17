/**
 * RT-632 (OBS-3) — the tunnel's capped body reader on a stream with no
 * `Content-Length` (chunked upload), plus the media-type gate.
 */
import { PassThrough } from "node:stream";

import { BadRequestException, PayloadTooLargeException, UnsupportedMediaTypeException } from "@nestjs/common";
import type { Request } from "express";

import { assertEnvelopeMediaType, readEnvelopeBody } from "../../src/console-telemetry/read-envelope-body";

function stream(headers: Record<string, string> = {}): PassThrough & { headers: Record<string, string> } {
  return Object.assign(new PassThrough(), { headers });
}

function asRequest(s: PassThrough & { headers: Record<string, string> }): Request {
  return s as unknown as Request;
}

describe("readEnvelopeBody", () => {
  it("returns the streamed bytes", async () => {
    const s = stream();
    const read = readEnvelopeBody(asRequest(s), 16);
    s.write(Buffer.from("ab"));
    s.end(Buffer.from("✓"));
    await expect(read).resolves.toEqual(Buffer.from("ab✓"));
  });

  it("rejects with 413 as soon as a chunked body passes the cap, without buffering the rest", async () => {
    const s = stream();
    const read = readEnvelopeBody(asRequest(s), 4);
    s.write(Buffer.from("abc"));
    s.write(Buffer.from("de"));
    await expect(read).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(s.listenerCount("data")).toBe(0);
    s.end();
  });

  it("rejects with 413 on a declared Content-Length over the cap before reading", async () => {
    const s = stream({ "content-length": "5" });
    await expect(readEnvelopeBody(asRequest(s), 4)).rejects.toBeInstanceOf(PayloadTooLargeException);
    s.end();
  });

  it("rejects with 400 when the stream errors", async () => {
    const s = stream();
    const read = readEnvelopeBody(asRequest(s), 16);
    s.destroy(new Error("aborted"));
    await expect(read).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("assertEnvelopeMediaType", () => {
  const req = (headers: Record<string, string>): Pick<Request, "headers"> => ({ headers });

  it.each([{}, { "content-type": "text/plain;charset=UTF-8" }, { "content-type": "Application/X-Sentry-Envelope" }, { "content-encoding": "identity" }])(
    "accepts %p",
    (headers) => {
      expect(() => assertEnvelopeMediaType(req(headers))).not.toThrow();
    },
  );

  it.each([{ "content-type": "application/json" }, { "content-encoding": "br" }])("refuses %p with 415", (headers) => {
    expect(() => assertEnvelopeMediaType(req(headers))).toThrow(UnsupportedMediaTypeException);
  });
});
