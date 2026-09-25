/**
 * PosOperatorsController — Wave 1 sign-in/sign-out + Wave 3 roster/takeover/active-session.
 *
 * Implements the full `pos-operators.openapi.yaml` surface.
 *
 *   - All endpoints carry the Clerk JWT as `Authorization: Bearer <jwt>`.
 *   - Bodies are validated by Zod (strict schemas); malformed bodies are
 *     rejected by `ZodValidationPipe` and rendered as 400 by the global filter.
 *   - Every refusal returns the same generic 401 envelope; the actual cause is
 *     logged server-side keyed by `request_id` and is not enumerated in the
 *     response body.
 *   - Wave 3 GET endpoints (`roster`, `active-session`) gate via Clerk JWT
 *     only — no device attestation parameter is present in the GET schema.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";

import { ClerkBearerGuard } from "../auth/clerk-bearer.guard";
import { ClerkBearer, requirePosBearer, type CredentialRequest } from "../auth/route-auth";

import { PosOperatorsService } from "./pos-operators.service";
import {
  PosActiveSessionQuerySchema,
  PosOperatorSignInSchema,
  PosOperatorSignOutSchema,
  PosRosterQuerySchema,
  PosTakeoverConfirmSchema,
  type PosActiveSessionQueryInput,
  type PosActiveSessionResponseBody,
  type PosOperatorSignInInput,
  type PosOperatorSignInResponseBody,
  type PosOperatorSignOutInput,
  type PosOperatorSignOutResponseBody,
  type PosRosterQueryInput,
  type PosRosterResponseBody,
  type PosTakeoverConfirmInput,
} from "./dto";
import { ZodValidationPipe } from "../common/zod-validation.pipe";

@ClerkBearer()
@UseGuards(ClerkBearerGuard)
@Controller("api/pos/v1/operators")
export class PosOperatorsController {
  constructor(private readonly service: PosOperatorsService) {}

  @Post("sign-in")
  @HttpCode(HttpStatus.OK)
  async signIn(
    @Body(new ZodValidationPipe(PosOperatorSignInSchema))
    body: PosOperatorSignInInput,
    @Req() req: CredentialRequest & { requestId?: string },
  ): Promise<PosOperatorSignInResponseBody> {
    const rawJwt = requirePosBearer(req);

    const requestId = req.requestId ?? "unknown";
    const result = await this.service.signIn(rawJwt, body, requestId);
    if (result.kind === "refused") {
      throw new UnauthorizedException("Unauthorized");
    }
    return result;
  }

  @Post("sign-out")
  @HttpCode(HttpStatus.OK)
  async signOut(
    @Body(new ZodValidationPipe(PosOperatorSignOutSchema))
    body: PosOperatorSignOutInput,
    @Req() req: CredentialRequest & { requestId?: string },
  ): Promise<PosOperatorSignOutResponseBody> {
    const rawJwt = requirePosBearer(req);
    const requestId = req.requestId ?? "unknown";
    const result = await this.service.signOut(rawJwt, body, requestId);
    if (result.kind === "refused") {
      throw new UnauthorizedException("Unauthorized");
    }
    return result;
  }

  @Get("roster")
  @HttpCode(HttpStatus.OK)
  async roster(
    @Query(new ZodValidationPipe(PosRosterQuerySchema))
    query: PosRosterQueryInput,
    @Req() req: CredentialRequest & { requestId?: string },
  ): Promise<PosRosterResponseBody> {
    const rawJwt = requirePosBearer(req);
    const requestId = req.requestId ?? "unknown";
    const result = await this.service.roster(rawJwt, query, requestId);
    if (!("cashiers" in result)) {
      throw new UnauthorizedException("Unauthorized");
    }
    return result;
  }

  @Post("takeover/confirm")
  @HttpCode(HttpStatus.OK)
  async takeoverConfirm(
    @Body(new ZodValidationPipe(PosTakeoverConfirmSchema))
    body: PosTakeoverConfirmInput,
    @Req() req: CredentialRequest & { requestId?: string },
  ): Promise<PosOperatorSignInResponseBody> {
    const rawJwt = requirePosBearer(req);
    const requestId = req.requestId ?? "unknown";
    const result = await this.service.takeoverConfirm(rawJwt, body, requestId);
    if (result.kind === "refused") {
      throw new UnauthorizedException("Unauthorized");
    }
    return result;
  }

  @Get("active-session")
  @HttpCode(HttpStatus.OK)
  async activeSession(
    @Query(new ZodValidationPipe(PosActiveSessionQuerySchema))
    query: PosActiveSessionQueryInput,
    @Req() req: CredentialRequest & { requestId?: string },
  ): Promise<PosActiveSessionResponseBody> {
    const rawJwt = requirePosBearer(req);
    const requestId = req.requestId ?? "unknown";
    const result = await this.service.activeSession(rawJwt, query, requestId);
    if (result.kind === "refused") {
      throw new UnauthorizedException("Unauthorized");
    }
    return result;
  }
}


