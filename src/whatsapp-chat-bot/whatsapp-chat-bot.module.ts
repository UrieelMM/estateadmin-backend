import { Module } from '@nestjs/common';
import { WhatsappChatBotController } from './whatsapp-chat-bot.controller';
import { WhatsappChatBotService } from './whatsapp-chat-bot.service';
import { PublicDocumentsService } from './public-documents.service';
import { AccountStatementService } from './account-statement.service';
import { ScheduledVisitsService } from './scheduled-visits.service';
import { CommonAreasBookingService } from './common-areas-booking.service';
import { KnowledgeBaseService } from './knowledge-base.service';
import { KnowledgeBaseController } from './knowledge-base.controller';
import { GeminiModule } from '../gemini/gemini.module';

@Module({
  imports: [GeminiModule],
  controllers: [WhatsappChatBotController, KnowledgeBaseController],
  providers: [
    WhatsappChatBotService,
    PublicDocumentsService,
    AccountStatementService,
    ScheduledVisitsService,
    CommonAreasBookingService,
    KnowledgeBaseService,
  ],
  exports: [
    WhatsappChatBotService,
    PublicDocumentsService,
    AccountStatementService,
    ScheduledVisitsService,
    CommonAreasBookingService,
    KnowledgeBaseService,
  ],
})
export class WhatsappChatBotModule {}
