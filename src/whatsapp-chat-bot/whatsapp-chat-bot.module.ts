import { Module } from '@nestjs/common';
import { WhatsappChatBotController } from './whatsapp-chat-bot.controller';
import { WhatsappChatBotService } from './whatsapp-chat-bot.service';
import { PublicDocumentsService } from './public-documents.service';
import { AccountStatementService } from './account-statement.service';
import { ScheduledVisitsService } from './scheduled-visits.service';

@Module({
  controllers: [WhatsappChatBotController],
  providers: [
    WhatsappChatBotService,
    PublicDocumentsService,
    AccountStatementService,
    ScheduledVisitsService,
  ],
  exports: [
    WhatsappChatBotService,
    PublicDocumentsService,
    AccountStatementService,
    ScheduledVisitsService,
  ],
})
export class WhatsappChatBotModule {}
