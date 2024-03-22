import { Module } from '@nestjs/common';
import { PublicationsService } from './publications.service';
import { PublicationsController } from './publications.controller';
import { FirebasesdkModule } from 'src/firebasesdk/firebasesdk.module';

@Module({
  imports: [FirebasesdkModule],
  controllers: [PublicationsController],
  providers: [PublicationsService],
})
export class PublicationsModule {}
