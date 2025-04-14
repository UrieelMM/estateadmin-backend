// src/whatsapp-chat-bot/whatsapp-chat-bot.controller.ts
import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  Headers,
  UnauthorizedException,
  Res,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { WhatsappChatBotService } from './whatsapp-chat-bot.service';
import { PaymentConfirmationDto } from 'src/dtos/whatsapp/payment-confirmation.dto';
import { WhatsappMessageDto } from 'src/dtos/whatsapp/whatsapp-message.dto';

@Controller('whatsapp-chat-bot')
export class WhatsappChatBotController {
  constructor(
    private readonly whatsappChatBotService: WhatsappChatBotService,
  ) {}

  /**
   * Endpoint para la verificación del webhook (GET).
   * Facebook envía los parámetros hub.mode, hub.verify_token y hub.challenge.
   * Si la verificación es correcta, se debe devolver hub.challenge exactamente.
   */
  @Get('webhook')
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    try {
      const expectedToken = 'estateadmin';
      console.log('Solicitud de verificación recibida:', {
        mode,
        token,
        challenge,
      });

      if (mode === 'subscribe' && token === expectedToken) {
        return res.status(HttpStatus.OK).send(challenge);
      } else {
        return res
          .status(HttpStatus.FORBIDDEN)
          .send('Verification token mismatch');
      }
    } catch (error) {
      console.error('Error en verifyWebhook:', error);
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send('Error interno');
    }
  }

  /**
   * Endpoint para el POST de mensajes y webhook.
   */
  @Post('webhook')
  async webhook(
    @Headers('x-whatsapp-token') headerToken: string,
    @Body() webhookData: any,
  ) {
    // Se espera que el token en el header coincida también
    // const expectedToken = 'estateadmin';
    // if (headerToken !== expectedToken) {
    //   throw new UnauthorizedException('Token inválido');
    // }
    console.log('Webhook POST recibido:', { headerToken, body: webhookData });
    return await this.whatsappChatBotService.processWebhook(webhookData);
  }

  /**
   * Endpoint para enviar mensajes.
   */
  @Post('send-message')
  async sendMessage(@Body() whatsappMessageDto: WhatsappMessageDto) {
    return await this.whatsappChatBotService.sendAndLogMessage(
      whatsappMessageDto,
    );
  }

  /**
   * Endpoint para confirmar el comprobante de pago.
   */
  @Post('confirm-payment')
  async confirmPayment(
    @Headers('x-whatsapp-token') headerToken: string,
    @Body() paymentDto: PaymentConfirmationDto,
  ) {
    // const expectedToken = 'estateadmin';
    // if (headerToken !== expectedToken) {
    //   throw new UnauthorizedException('Token inválido');
    // }
    console.log('Confirmar pago:', { headerToken, body: paymentDto });
    return await this.whatsappChatBotService.confirmPayment(paymentDto);
  }
}
