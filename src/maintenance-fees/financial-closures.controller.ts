import { Body, Controller, Get, Headers, Param, Post, Query, UnauthorizedException } from '@nestjs/common';
import { FinancialClosuresService, ClosureDirection } from './financial-closures.service';

@Controller('financial-closures')
export class FinancialClosuresController {
  constructor(private readonly service: FinancialClosuresService) {}

  private async actor(authorization: string, clientId: string, condominiumId: string) {
    if (!authorization?.startsWith('Bearer ')) throw new UnauthorizedException('Inicia sesión para continuar.');
    return this.service.assertAdmin(authorization.slice(7), clientId, condominiumId);
  }

  @Get('movements')
  async movements(@Headers('authorization') authorization: string, @Query() query: Record<string, string>) {
    await this.actor(authorization, query.clientId, query.condominiumId);
    return this.service.movements({
      clientId: query.clientId, condominiumId: query.condominiumId,
      from: query.from, to: query.to,
      direction: (['income', 'expense'].includes(query.direction) ? query.direction : 'all') as ClosureDirection,
      search: query.search, page: Number(query.page), limit: Number(query.limit),
    });
  }

  @Get()
  async list(@Headers('authorization') authorization: string, @Query() query: Record<string, string>) {
    await this.actor(authorization, query.clientId, query.condominiumId);
    return this.service.list(query.clientId, query.condominiumId, Number(query.page), Number(query.limit));
  }

  @Get(':month')
  async get(@Headers('authorization') authorization: string, @Param('month') month: string, @Query() query: Record<string, string>) {
    await this.actor(authorization, query.clientId, query.condominiumId);
    return this.service.get(query.clientId, query.condominiumId, month);
  }

  @Post('close')
  async close(@Headers('authorization') authorization: string, @Body() body: Record<string, any>) {
    const actor = await this.actor(authorization, body.clientId, body.condominiumId);
    return this.service.close({ clientId: body.clientId, condominiumId: body.condominiumId,
      month: body.month, openingBalanceCents: body.openingBalanceCents,
      expectedDigest: body.expectedDigest, actorUid: actor.uid });
  }

  @Post(':month/request-reopen')
  async requestReopen(@Headers('authorization') authorization: string, @Param('month') month: string, @Body() body: Record<string, string>) {
    const actor = await this.actor(authorization, body.clientId, body.condominiumId);
    return this.service.requestReopen({ clientId: body.clientId, condominiumId: body.condominiumId, month, actorUid: actor.uid });
  }

  @Post(':month/reopen')
  async reopen(@Headers('authorization') authorization: string, @Param('month') month: string, @Body() body: Record<string, string>) {
    const actor = await this.actor(authorization, body.clientId, body.condominiumId);
    return this.service.reopen({ clientId: body.clientId, condominiumId: body.condominiumId,
      month, code: body.code, actorUid: actor.uid });
  }
}
