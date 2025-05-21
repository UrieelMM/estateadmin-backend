import { Module } from '@nestjs/common';
import { AiContextController } from './ai-context.controller';
import { AiContextService } from './ai-context.service';
import { GeminiModule } from '../gemini/gemini.module';
import { ConfigModule } from '@nestjs/config';
import { MpcModule } from '../mpc/mpc.module';

@Module({
  imports: [GeminiModule, ConfigModule, MpcModule],
  controllers: [AiContextController],
  providers: [AiContextService],
  exports: [AiContextService],
})
export class AiContextModule {}
