import {
  BadRequestException,
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

  // ─────────────────────────────────────────────────────────────────────────
  // Endpoints públicos para el dashboard de caseta (solo lectura, auth = PIN)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * POST /scheduled-visits-caseta/dashboard/validate-pin
   * Valida el PIN de caseta sin requerir Firebase Auth.
   * Body: { clientId, condominiumId, pin }
   * Responde: { valid: boolean }
   *
   * Rate-limit estricto: 10 intentos / 60 s para dificultar fuerza bruta.
   */
  @Post('dashboard/validate-pin')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async validatePinPublic(
    @Body() body: { clientId?: string; condominiumId?: string; pin?: string },
  ) {
    const { clientId, condominiumId, pin } = body ?? {};
    if (!clientId || !condominiumId || !pin) {
      throw new BadRequestException('clientId, condominiumId y pin son requeridos.');
    }
    if (!/^\d{6}$/.test(pin)) {
      return { valid: false };
    }
    const valid = await this.scheduledVisitsService.validateCasetaPinPublic(
      clientId,
      condominiumId,
      pin,
    );
    return { valid };
  }

  /**
   * POST /scheduled-visits-caseta/dashboard/register
   * Registra entrada o salida manualmente desde el dashboard de caseta.
   * Úsalo cuando el visitante no tiene su QR pero se puede identificar.
   *
   * Body: { clientId, condominiumId, pin, visitId, type: 'check-in'|'check-out' }
   * Auth: PIN (sin Firebase Auth).
   * Rate-limit: 20 / 60 s.
   */
  @Post('dashboard/register')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async registerManual(
    @Body()
    body: {
      clientId?: string;
      condominiumId?: string;
      pin?: string;
      visitId?: string;
      type?: string;
    },
  ) {
    const { clientId, condominiumId, pin, visitId, type } = body ?? {};
    if (!clientId || !condominiumId || !pin || !visitId || !type) {
      throw new BadRequestException(
        'clientId, condominiumId, pin, visitId y type son requeridos.',
      );
    }
    if (!/^\d{6}$/.test(pin)) {
      throw new BadRequestException('PIN inválido.');
    }
    if (type !== 'check-in' && type !== 'check-out') {
      throw new BadRequestException('type debe ser check-in o check-out.');
    }
    const result = await this.scheduledVisitsService.registerVisitEntryByCaseta(
      visitId,
      clientId,
      condominiumId,
      pin,
      type as 'check-in' | 'check-out',
    );
    if (!result.ok) {
      throw new BadRequestException(result.reason ?? 'Error al registrar.');
    }
    return { ok: true, entryId: result.entryId };
  }

  /**
   * GET /scheduled-visits-caseta/dashboard/visits
   * Retorna la lista de visitas agendadas del condominio.
   * Query params: clientId, condominiumId, pin, limit? (1–500, default 200)
   *
   * Requiere PIN válido — sin Firebase Auth.
   * Solo lectura: la caseta no puede modificar visitas desde aquí.
   */
  @Get('dashboard/visits')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async getCasetaVisits(
    @Query('clientId') clientId: string,
    @Query('condominiumId') condominiumId: string,
    @Query('pin') pin: string,
    @Query('limit') limitParam?: string,
  ) {
    if (!clientId || !condominiumId || !pin) {
      throw new BadRequestException('clientId, condominiumId y pin son requeridos.');
    }
    if (!/^\d{6}$/.test(pin)) {
      throw new BadRequestException('PIN inválido.');
    }
    const limitCount = limitParam ? Math.min(parseInt(limitParam, 10) || 200, 500) : 200;
    try {
      const visits = await this.scheduledVisitsService.getCasetaVisits(
        clientId,
        condominiumId,
        pin,
        limitCount,
      );
      return { ok: true, visits };
    } catch (err: any) {
      throw new BadRequestException(err?.message || 'Error al obtener visitas.');
    }
  }
}
