import { Module } from '@nestjs/common';
import { ToolsController } from './tools.controller';
import { ToolsService } from './tools.service';
import { ThrottlerModule } from '@nestjs/throttler';
import { AttendanceQrController } from './attendance-qr.controller';
import { ScheduledVisitsQrController } from './scheduled-visits-qr.controller';
import { ScheduledVisitsCasetaController } from './scheduled-visits-caseta.controller';
import { WhatsappChatBotModule } from '../whatsapp-chat-bot/whatsapp-chat-bot.module';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        ttl: 60,
        limit: 10,
      },
    ]),
    // Importamos WhatsappChatBotModule para reutilizar ScheduledVisitsService
    // (que ya está exportado allí) en el controlador público de visitas.
    WhatsappChatBotModule,
  ],
  controllers: [
    ToolsController,
    AttendanceQrController,
    ScheduledVisitsQrController,
    ScheduledVisitsCasetaController,
  ],
  providers: [ToolsService],
  exports: [ToolsService],
})
export class ToolsModule {}
