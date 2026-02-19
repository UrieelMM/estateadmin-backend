import { Module } from '@nestjs/common';
import { ToolsController } from './tools.controller';
import { ToolsService } from './tools.service';
import { ThrottlerModule } from '@nestjs/throttler';
import { AttendanceQrController } from './attendance-qr.controller';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        ttl: 60,
        limit: 10,
      },
    ]),
  ],
  controllers: [ToolsController, AttendanceQrController],
  providers: [ToolsService],
  exports: [ToolsService],
})
export class ToolsModule {}
