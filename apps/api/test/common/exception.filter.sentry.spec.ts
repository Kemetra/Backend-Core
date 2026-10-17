/**
 * Spec 037 US1 — GlobalExceptionFilter reports server errors to Sentry.
 * The filter swallows every exception into the error envelope, so Sentry's
 * own handlers never see it; the filter is the capture point. Only genuine
 * server errors are reported: unhandled throws and HttpException >= 500.
 */
import "reflect-metadata";

import {
  type ArgumentsHost,
  BadRequestException,
  HttpException,
  NotFoundException,
} from "@nestjs/common";
import { z } from "zod";

import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { captureServerError } from "../../src/observability/sentry/sentry";

jest.mock("../../src/observability/sentry/sentry", () => ({
  captureServerError: jest.fn(),
}));

const REQUEST_ID = "018f3b1d-7c2a-7e3a-9bcd-0123456789ab";

function makeHost(): ArgumentsHost {
  const res = { status: () => ({ json: () => undefined }) };
  return {
    switchToHttp: () => ({
      getRequest: <T>() => ({ requestId: REQUEST_ID }) as unknown as T,
      getResponse: <T>() => res as unknown as T,
    }),
  } as unknown as ArgumentsHost;
}

describe("GlobalExceptionFilter -> Sentry", () => {
  const filter = new GlobalExceptionFilter();

  it("captures an unhandled Error", () => {
    const err = new Error("db exploded");
    filter.catch(err, makeHost());
    expect(captureServerError).toHaveBeenCalledWith(err, REQUEST_ID);
  });

  it("captures an unhandled non-Error throw", () => {
    filter.catch("thrown string", makeHost());
    expect(captureServerError).toHaveBeenCalledWith("thrown string", REQUEST_ID);
  });

  it("captures an HttpException with status >= 500", () => {
    const err = new HttpException("down", 503);
    filter.catch(err, makeHost());
    expect(captureServerError).toHaveBeenCalledWith(err, REQUEST_ID);
  });

  it.each([
    ["400", new BadRequestException("bad")],
    ["404", new NotFoundException("nope")],
  ])("does not capture an HttpException %s", (_label, err) => {
    filter.catch(err, makeHost());
    expect(captureServerError).not.toHaveBeenCalled();
  });

  it("does not capture a ZodError (client validation)", () => {
    const parsed = z.object({ x: z.string() }).safeParse({ x: 1 });
    if (parsed.success) throw new Error("expected failure");
    filter.catch(parsed.error, makeHost());
    expect(captureServerError).not.toHaveBeenCalled();
  });

  it("tags the capture with the request_id the client sees, even when it was minted here", () => {
    let sent: { error: { request_id: string } } | undefined;
    const res = {
      status: () => ({
        json: (body: typeof sent) => {
          sent = body;
        },
      }),
    };
    const host = {
      switchToHttp: () => ({
        getRequest: <T>() => ({}) as unknown as T,
        getResponse: <T>() => res as unknown as T,
      }),
    } as unknown as ArgumentsHost;
    const err = new Error("no interceptor ran");
    filter.catch(err, host);
    expect(sent?.error.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(captureServerError).toHaveBeenCalledWith(err, sent?.error.request_id);
  });

  it("does not capture when the response was already sent", () => {
    const host = {
      switchToHttp: () => ({
        getRequest: <T>() => ({}) as unknown as T,
        getResponse: <T>() => ({ headersSent: true }) as unknown as T,
      }),
    } as unknown as ArgumentsHost;
    filter.catch(new Error("late"), host);
    expect(captureServerError).not.toHaveBeenCalled();
  });
});
