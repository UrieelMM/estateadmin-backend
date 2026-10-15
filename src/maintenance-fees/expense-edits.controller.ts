import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { Request } from 'express';
import { ExpenseEditCommitDto, ExpenseEditTenantQueryDto } from 'src/dtos/expense-edits.dto';
import { ExpenseEditsService } from './expense-edits.service';
import {
  getHeaderValue,
  getRequestIp,
  resolveFinancialAdmin,
} from './financial-admin-auth';

@Controller('expenses/edits')
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }),
)
export class ExpenseEditsController {
  constructor(private readonly expenseEditsService: ExpenseEditsService) {}

  @Get('eligibility')
  async eligibility(@Query() query: ExpenseEditTenantQueryDto, @Req() req: Request) {
    await resolveFinancialAdmin(req, query.clientId, query.condominiumId);
    return this.expenseEditsService.getEligibility(query);
  }

  @Post('commit')
  async commit(@Body() dto: ExpenseEditCommitDto, @Req() req: Request) {
    const actor = await resolveFinancialAdmin(req, dto.clientId, dto.condominiumId);
    return this.expenseEditsService.commitEdit({
      dto,
      actor,
      idempotencyKey: getHeaderValue(req, 'x-idempotency-key'),
      sourceIp: getRequestIp(req),
    });
  }

  @Get('history')
  async history(@Query() query: ExpenseEditTenantQueryDto, @Req() req: Request) {
    await resolveFinancialAdmin(req, query.clientId, query.condominiumId);
    return this.expenseEditsService.getEditHistory(query);
  }
}
