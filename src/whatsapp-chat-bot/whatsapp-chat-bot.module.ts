import { Module } from '@nestjs/common';
import { WhatsappChatBotController } from './whatsapp-chat-bot.controller';
import { WhatsappChatBotService } from './whatsapp-chat-bot.service';

@Module({
  controllers: [WhatsappChatBotController],
  providers: [WhatsappChatBotService],
  exports: [WhatsappChatBotService],
})
export class WhatsappChatBotModule {}
