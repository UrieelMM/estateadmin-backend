import { Module } from '@nestjs/common';
import { WhatsappChatBotController } from './whatsapp-chat-bot.controller';
import { WhatsappChatBotService } from './whatsapp-chat-bot.service';
import { PublicDocumentsService } from './public-documents.service';

@Module({
  controllers: [WhatsappChatBotController],
  providers: [WhatsappChatBotService, PublicDocumentsService],
  exports: [WhatsappChatBotService, PublicDocumentsService],
})
export class WhatsappChatBotModule {}
