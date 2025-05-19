import { Controller, Get, Param, UseGuards, Post, Body } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { CondominiumUsersService } from './condominium-users.service';

@Controller('clients/:clientId/condominiums/:condominiumId')
@UseGuards(ThrottlerGuard)
export class CondominiumUsersController {
  constructor(
    private readonly condominiumUsersService: CondominiumUsersService,
  ) {}

  @Get('users')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async getCondominiumUsers(
    @Param('clientId') clientId: string,
    @Param('condominiumId') condominiumId: string,
  ) {
    return this.condominiumUsersService.getCondominiumUsers(
      clientId,
      condominiumId,
    );
  }
  
  @Get('limit')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async getCondominiumLimit(
    @Param('clientId') clientId: string,
    @Param('condominiumId') condominiumId: string,
  ) {
    return this.condominiumUsersService.getCondominiumLimit(
      clientId,
      condominiumId,
    );
  }
}
