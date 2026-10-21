import {
  Controller,
  Get,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";

import { OperatorBearerGuard } from "../auth/operator-bearer.guard";
import { OperatorBearer, requirePosBearer, type CredentialRequest } from "../auth/route-auth";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { PosShiftsService } from "./pos-shifts.service";
import { StuckShiftsQuerySchema } from "./dto";

@OperatorBearer()
@UseGuards(OperatorBearerGuard)
@Controller("api/pos/v1/shifts")
export class PosShiftsController {
  constructor(private readonly posShiftsService: PosShiftsService) {}

  @Get("stuck")
  async getStuck(
    @Query(new ZodValidationPipe(StuckShiftsQuerySchema)) query: { branch_id: string },
    @Req() req: CredentialRequest & { requestId?: string },
  ) {
    const rawJwt = requirePosBearer(req);

    const requestId = req.requestId ?? null;
    const result = await this.posShiftsService.getStuck(rawJwt, query.branch_id, requestId);

    if (result.kind === "refused") {
      throw new UnauthorizedException("Unauthorized");
    }

    return result.body;
  }
}
