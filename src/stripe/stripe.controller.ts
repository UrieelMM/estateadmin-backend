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
  @IsUrl({ require_tld: false })
  successUrl: string;

  @IsNotEmpty()
  @IsUrl({ require_tld: false })
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
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
    @Headers('stripe-signature') signature: string,
  ) {
    if (!signature) {
      throw new BadRequestException('No se encontró la firma de Stripe');
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
      throw new BadRequestException(
        'No se pudo leer el cuerpo de la solicitud',
      );
    }

    try {
      const result = await this.stripeService.processWebhookEvent(
        signature,
        rawBody,
      );
      return res.status(HttpStatus.OK).json(result);
    } catch (error) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        message: error.message,
      });
    }
  }
}
