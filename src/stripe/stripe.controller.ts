import {
  Controller,
  Post,
  Body,
  Req,
  Res,
  HttpStatus,
  Headers,
  RawBodyRequest,
  UsePipes,
  ValidationPipe,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { StripeService } from './stripe.service';
import {
  IsNotEmpty,
  IsString,
  IsNumber,
  IsUrl,
  IsEmail,
  IsOptional,
} from 'class-validator';

// DTO para crear sesión de checkout
class CreateCheckoutSessionDto {
  @IsNotEmpty()
  @IsString()
  invoiceId: string;

  @IsNotEmpty()
  @IsString()
  clientId: string;

  @IsNotEmpty()
  @IsString()
  condominiumId: string;

  @IsNotEmpty()
  @IsNumber()
  amount: number;

  @IsNotEmpty()
  @IsString()
  invoiceNumber: string;

  @IsNotEmpty()
  @IsEmail()
  userEmail: string;

  @IsOptional()
  @IsString()
  description?: string;

  // Se permite URL locales al deshabilitar el requerimiento de TLD
  //TODO: Cambiar a true cuando se esté en producción
  @IsNotEmpty()
  @IsUrl({ require_tld: true })
  successUrl: string;

  @IsNotEmpty()
  @IsUrl({ require_tld: true })
  cancelUrl: string;
}

// DTO para verificar estado de sesión
class CheckSessionStatusDto {
  @IsNotEmpty()
  @IsString()
  sessionId: string;
}

@Controller('stripe')
export class StripeController {
  private readonly logger = new Logger(StripeController.name);

  constructor(private readonly stripeService: StripeService) {}

  /**
   * Endpoint para crear una sesión de checkout de Stripe
   */
  @Post('create-checkout-session')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  async createCheckoutSession(
    @Body() createCheckoutSessionDto: CreateCheckoutSessionDto,
  ) {
    return this.stripeService.createCheckoutSession(createCheckoutSessionDto);
  }

  /**
   * Endpoint para verificar el estado de una sesión de pago
   */
  @Post('check-session')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  async checkSessionStatus(
    @Body() checkSessionStatusDto: CheckSessionStatusDto,
  ) {
    return this.stripeService.checkSessionStatus(
      checkSessionStatusDto.sessionId,
    );
  }

  /**
   * Endpoint para recibir webhooks de Stripe
   * Nota: Es importante usar @Req() para acceder al raw body sin parsear
   */
  @Post('webhook')
  async handleWebhook(
    @Req() req: Request,
    @Res() res: Response,
    @Headers('stripe-signature') signature: string,
  ) {
    this.logger.log('Webhook recibido');

    if (!signature) {
      this.logger.error('No se encontró la firma de Stripe');
      return res.status(HttpStatus.BAD_REQUEST).json({
        message: 'No se encontró la firma de Stripe',
      });
    }

    // Con el middleware configurado correctamente, req.body debe ser un Buffer
    const rawBody = req.body;
    if (!rawBody) {
      this.logger.error('No se recibió el cuerpo de la solicitud');
      return res.status(HttpStatus.BAD_REQUEST).json({
        message: 'No se pudo leer el cuerpo de la solicitud',
      });
    }

    try {
      this.logger.log(
        `Procesando webhook, tipo de cuerpo: ${typeof rawBody}, ¿es Buffer? ${Buffer.isBuffer(rawBody)}`,
      );

      // Primero verificar la firma y obtener el evento
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!webhookSecret) {
        throw new BadRequestException(
          'No se ha configurado STRIPE_WEBHOOK_SECRET',
        );
      }

      // Parsear el payload para obtener clientId y condominiumId
      const event = JSON.parse(rawBody.toString());
      const { clientId, condominiumId } = event.data?.object?.metadata || {};

      if (!clientId || !condominiumId) {
        this.logger.warn(
          `Evento ${event.type} sin clientId o condominiumId, ignorando...`,
        );
        return res
          .status(HttpStatus.OK)
          .json({ received: true, ignored: true });
      }

      const result = await this.stripeService.processWebhookEvent(
        signature,
        rawBody,
        clientId,
        condominiumId,
      );
      this.logger.log('Webhook procesado exitosamente');
      return res.status(HttpStatus.OK).json(result);
    } catch (error) {
      this.logger.error(`Error en el webhook: ${error.message}`, error.stack);
      return res.status(HttpStatus.BAD_REQUEST).json({
        message: error.message,
      });
    }
  }
}
