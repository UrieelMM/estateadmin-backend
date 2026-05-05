import { Module } from '@nestjs/common';
import { WhatsappChatBotController } from './whatsapp-chat-bot.controller';
import { WhatsappChatBotService } from './whatsapp-chat-bot.service';
import { PublicDocumentsService } from './public-documents.service';
import { AccountStatementService } from './account-statement.service';
import { ScheduledVisitsService } from './scheduled-visits.service';
import { CommonAreasBookingService } from './common-areas-booking.service';

@Module({
  controllers: [WhatsappChatBotController],
  providers: [
    WhatsappChatBotService,
    PublicDocumentsService,
    AccountStatementService,
    ScheduledVisitsService,
    CommonAreasBookingService,
  ],
  exports: [
    WhatsappChatBotService,
    PublicDocumentsService,
    AccountStatementService,
    ScheduledVisitsService,
    CommonAreasBookingService,
  ],
})
export class WhatsappChatBotModule {}
