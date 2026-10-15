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
import {
  ExpenseReversalCommitDto,
  ExpenseReversalHistoryQueryDto,
  ExpenseReversalPreviewDto,
} from 'src/dtos/expense-reversals.dto';
import { ExpenseReversalsService } from './expense-reversals.service';
import {
  getHeaderValue,
  getRequestIp,
  resolveFinancialAdmin,
} from './financial-admin-auth';

@Controller('expenses/reversals')
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }),
)
export class ExpenseReversalsController {
  constructor(private readonly expenseReversalsService: ExpenseReversalsService) {}

  @Post('preview')
  async preview(@Body() dto: ExpenseReversalPreviewDto, @Req() req: Request) {
    const actor = await resolveFinancialAdmin(req, dto.clientId, dto.condominiumId);
    return this.expenseReversalsService.previewReversal(dto, actor);
  }

  @Post('commit')
  async commit(@Body() dto: ExpenseReversalCommitDto, @Req() req: Request) {
    const actor = await resolveFinancialAdmin(req, dto.clientId, dto.condominiumId);
    return this.expenseReversalsService.commitReversal({
      dto,
      actor,
      idempotencyKey: getHeaderValue(req, 'x-idempotency-key'),
      sourceIp: getRequestIp(req),
    });
  }

  @Get('history')
  async history(@Query() query: ExpenseReversalHistoryQueryDto, @Req() req: Request) {
    await resolveFinancialAdmin(req, query.clientId, query.condominiumId);
    return this.expenseReversalsService.getReversalHistory(query);
  }
}
