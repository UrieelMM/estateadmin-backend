import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { Request } from 'express';
import {
  OpeningCreditCancelDto,
  OpeningCreditCreateDto,
  OpeningCreditTenantQueryDto,
} from 'src/dtos/opening-credits.dto';
import { OpeningCreditsService } from './opening-credits.service';
import { resolveFinancialAdmin } from './financial-admin-auth';

@Controller('opening-credits')
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }),
)
export class OpeningCreditsController {
  constructor(private readonly openingCreditsService: OpeningCreditsService) {}

  @Get()
  async list(@Query() query: OpeningCreditTenantQueryDto, @Req() req: Request) {
    await resolveFinancialAdmin(req, query.clientId, query.condominiumId);
    return this.openingCreditsService.list(query.clientId, query.condominiumId);
  }

  @Post()
  async create(@Body() dto: OpeningCreditCreateDto, @Req() req: Request) {
    const actor = await resolveFinancialAdmin(req, dto.clientId, dto.condominiumId);
    return this.openingCreditsService.create(dto, actor);
  }

  @Post(':id/cancel')
  async cancel(
    @Param('id') id: string,
    @Body() dto: OpeningCreditCancelDto,
    @Req() req: Request,
  ) {
    const actor = await resolveFinancialAdmin(req, dto.clientId, dto.condominiumId);
    return this.openingCreditsService.cancel(id, dto, actor);
  }
}
