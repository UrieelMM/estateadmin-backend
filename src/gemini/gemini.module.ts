import { Module } from '@nestjs/common';
import { GeminiService } from './gemini.service';
import { GeminiController } from './gemini.controller';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [ConfigModule], // Import ConfigModule to access environment variables
  controllers: [GeminiController],
  providers: [GeminiService],
  exports: [GeminiService], // Export service if needed elsewhere
})
export class GeminiModule {}
