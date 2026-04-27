import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduledVisitsService } from '../whatsapp-chat-bot/scheduled-visits.service';
import {
  RegisterVisitEntryDto,
  ValidateVisitQrQueryDto,
} from 'src/dtos/tools';

/**
 * Endpoints públicos para la caseta. Reciben el qrId en la URL y validan
 * con el `token` (parámetro requerido). El token es un secreto generado por
 * el bot al crear la visita; no es adivinable.
 */
@Controller('scheduled-visits-qr')
@UseGuards(ThrottlerGuard)
export class ScheduledVisitsQrController {
  constructor(
    private readonly scheduledVisitsService: ScheduledVisitsService,
  ) {}

  @Get(':qrId')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async validateQr(
    @Param('qrId') qrId: string,
    @Query() query: ValidateVisitQrQueryDto,
  ) {
    return this.scheduledVisitsService.validateVisitQr(
      qrId,
      query.token,
      query.clientId,
      query.condominiumId,
    );
  }

  @Post(':qrId/register')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async registerEntry(
    @Param('qrId') qrId: string,
    @Body() body: RegisterVisitEntryDto,
  ) {
    return this.scheduledVisitsService.registerVisitEntry(
      qrId,
      body.token,
      body.type,
      body.clientId,
      body.condominiumId,
    );
  }
}
