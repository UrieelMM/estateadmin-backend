import { Module } from '@nestjs/common';
import { WhatsappChatBotController } from './whatsapp-chat-bot.controller';
import { WhatsappChatBotService } from './whatsapp-chat-bot.service';
import { PublicDocumentsService } from './public-documents.service';
import { AccountStatementService } from './account-statement.service';

@Module({
  controllers: [WhatsappChatBotController],
  providers: [
    WhatsappChatBotService,
    PublicDocumentsService,
    AccountStatementService,
  ],
  exports: [
    WhatsappChatBotService,
    PublicDocumentsService,
    AccountStatementService,
  ],
})
export class WhatsappChatBotModule {}
