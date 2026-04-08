import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import * as admin from 'firebase-admin';
import { Request } from 'express';
import {
  PaymentReversalCommitDto,
  PaymentReversalHistoryQueryDto,
  PaymentReversalPreviewDto,
} from 'src/dtos/payment-reversals.dto';
import { PaymentReversalsService } from './payment-reversals.service';

type VerifiedActor = {
  uid: string;
  email: string;
  role: string;
  clientId: string;
  condominiumId?: string;
};

@Controller('payments/reversals')
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }),
)
export class PaymentReversalsController {
  constructor(
    private readonly paymentReversalsService: PaymentReversalsService,
  ) {}

  @Post('preview')
  async preview(
    @Body() dto: PaymentReversalPreviewDto,
    @Req() req: Request,
  ) {
    const actor = await this.authorize(req, dto.clientId, dto.condominiumId);
    return this.paymentReversalsService.previewReversal(dto, actor);
  }

  @Post('commit')
  async commit(
    @Body() dto: PaymentReversalCommitDto,
    @Req() req: Request,
  ) {
    const actor = await this.authorize(req, dto.clientId, dto.condominiumId);
    const idempotencyKey = this.getHeaderValue(req, 'x-idempotency-key');
    if (!idempotencyKey) {
      throw new HttpException(
        {
          ok: false,
          message: 'Header X-Idempotency-Key es obligatorio.',
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          details: {},
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.paymentReversalsService.commitReversal({
      dto,
      actor,
      idempotencyKey,
      sourceIp: this.getRequestIp(req),
    });
  }

  @Get('history')
  async history(
    @Query() query: PaymentReversalHistoryQueryDto,
    @Req() req: Request,
  ) {
    const actor = await this.authorize(
      req,
      query.clientId,
      query.condominiumId,
    );
    return this.paymentReversalsService.getReversalHistory(query, actor);
  }

  private async authorize(
    req: Request,
    clientId: string,
    condominiumId: string,
  ) {
    const token = this.extractBearerToken(req);

    let decodedToken: admin.auth.DecodedIdToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(token, true);
    } catch {
      throw new UnauthorizedException('Token inválido o expirado.');
    }

    const actor: VerifiedActor = {
      uid: decodedToken.uid,
      email: decodedToken.email || '',
      role: String(decodedToken.role || '').trim(),
      clientId: String(decodedToken.clientId || '').trim(),
      condominiumId: String(decodedToken.condominiumId || '').trim() || undefined,
    };

    return this.paymentReversalsService.assertTenantAdminAccess({
      clientId,
      condominiumId,
      actor,
    });
  }

  private extractBearerToken(req: Request): string {
    const authHeader = String(req.headers.authorization || '');
    if (!authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authorization Bearer token requerido.');
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      throw new UnauthorizedException('Token vacío.');
    }

    return token;
  }

  private getHeaderValue(req: Request, headerName: string): string {
    const raw = req.headers[headerName];
    if (typeof raw === 'string') {
      return raw.trim();
    }
    if (Array.isArray(raw) && raw.length) {
      return String(raw[0]).trim();
    }
    return '';
  }

  private getRequestIp(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',')[0].trim();
    }
    if (Array.isArray(forwarded) && forwarded[0]) {
      return String(forwarded[0]).trim();
    }
    return req.ip || '';
  }
}
