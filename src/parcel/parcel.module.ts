import { Module } from '@nestjs/common';
import { ParcelService } from './parcel.service';
import { ParcelController } from './parcel.controller';
import { FirebasesdkModule } from 'src/firebasesdk/firebasesdk.module';

@Module({
  imports: [FirebasesdkModule],
  controllers: [ParcelController],
  providers: [ParcelService],
})
export class ParcelModule {}
