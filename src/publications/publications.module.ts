import { Module } from '@nestjs/common';
import { PublicationsService } from './publications.service';
import { PublicationsController } from './publications.controller';
import { FirebasesdkModule } from 'src/firebasesdk/firebasesdk.module';
import { WhatsappChatBotModule } from 'src/whatsapp-chat-bot/whatsapp-chat-bot.module';

@Module({
  imports: [FirebasesdkModule, WhatsappChatBotModule],
  controllers: [PublicationsController],
  providers: [PublicationsService],
})
export class PublicationsModule {}
