import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Logger,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import * as admin from 'firebase-admin';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduledVisitsService } from '../whatsapp-chat-bot/scheduled-visits.service';
import {
  CasetaPinStatusQueryDto,
  ClearCasetaPinDto,
  SetCasetaPinDto,
} from 'src/dtos/tools';

const ALLOWED_ROLES = ['admin', 'admin-assistant', 'super-provider-admin'];

/**
 * Endpoints administrativos para gestionar el PIN de caseta usado al validar
 * entradas/salidas de visitas programadas.
 *
 * Auth: Bearer token de Firebase Auth en el header `Authorization`.
 * El token debe pertenecer a un usuario con rol admin / admin-assistant /
 * super-provider-admin (super-provider-admin puede tocar cualquier cliente).
 */
@Controller('scheduled-visits-caseta')
@UseGuards(ThrottlerGuard)
export class ScheduledVisitsCasetaController {
  private readonly logger = new Logger(ScheduledVisitsCasetaController.name);

  constructor(
    private readonly scheduledVisitsService: ScheduledVisitsService,
  ) {}

  /**
   * Verifica el ID token de Firebase y devuelve el decoded token.
   * Lanza UnauthorizedException si el token es inválido.
   */
  private async verifyAuth(authHeader?: string) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Falta el header Authorization Bearer.');
    }
    const idToken = authHeader.slice(7).trim();
    if (!idToken) {
      throw new UnauthorizedException('Token vacío.');
    }
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      return decoded;
    } catch (e) {
      this.logger.warn(`Token inválido: ${e.message}`);
      throw new UnauthorizedException('Token inválido o expirado.');
    }
  }

  /**
   * Valida que el usuario tenga rol admin/assistant/super-admin y, salvo que
   * sea super-admin, que su clientId coincida con el del recurso.
   */
  private assertCanManageClient(
    decoded: admin.auth.DecodedIdToken,
    clientId: string,
  ) {
    const role: string =
      (decoded as any).role ||
      (decoded as any).userRole ||
      (Array.isArray((decoded as any).roles)
        ? (decoded as any).roles[0]
        : null);

    if (!role || !ALLOWED_ROLES.includes(role)) {
      throw new ForbiddenException(
        'Tu rol no tiene permiso para gestionar el PIN de caseta.',
      );
    }
    if (role === 'super-provider-admin') return;
    const tokenClientId = (decoded as any).clientId;
    if (!tokenClientId || tokenClientId !== clientId) {
      throw new ForbiddenException(
        'No puedes gestionar el PIN de un cliente al que no perteneces.',
      );
    }
  }

  /**
   * POST /scheduled-visits-caseta/pin
   * Setea o actualiza el PIN de 6 dígitos de la caseta para un condominio.
   *
   * Body: { clientId, condominiumId, pin }
   * Headers: Authorization: Bearer <firebase_id_token>
   */
  @Post('pin')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async setPin(
    @Headers('authorization') authHeader: string,
    @Body() body: SetCasetaPinDto,
  ) {
    const decoded = await this.verifyAuth(authHeader);
    this.assertCanManageClient(decoded, body.clientId);

    await this.scheduledVisitsService.setCasetaPin(
      body.clientId,
      body.condominiumId,
      body.pin,
      decoded.uid,
    );
    return { ok: true };
  }

  /**
   * GET /scheduled-visits-caseta/pin/status?clientId=...&condominiumId=...
   * Indica si el condominio ya tiene PIN configurado, cuándo y por quién.
   * NO devuelve el PIN ni el hash.
   */
  @Get('pin/status')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async getPinStatus(
    @Headers('authorization') authHeader: string,
    @Query() query: CasetaPinStatusQueryDto,
  ) {
    const decoded = await this.verifyAuth(authHeader);
    this.assertCanManageClient(decoded, query.clientId);
    return this.scheduledVisitsService.getCasetaPinStatus(
      query.clientId,
      query.condominiumId,
    );
  }

  /**
   * DELETE /scheduled-visits-caseta/pin
   * Elimina el PIN del condominio. Mientras no haya PIN, las visitas pueden
   * registrarse sin él (modo legacy). Útil si quieren reiniciarlo.
   *
   * Body: { clientId, condominiumId }
   */
  @Delete('pin')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async clearPin(
    @Headers('authorization') authHeader: string,
    @Body() body: ClearCasetaPinDto,
  ) {
    const decoded = await this.verifyAuth(authHeader);
    this.assertCanManageClient(decoded, body.clientId);
    await this.scheduledVisitsService.clearCasetaPin(
      body.clientId,
      body.condominiumId,
    );
    return { ok: true };
  }
}
