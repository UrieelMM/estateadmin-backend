import { Module } from '@nestjs/common';
import { MaintenanceFeesService } from './maintenance-fees.service';
import { MaintenanceFeesController } from './maintenance-fees.controller';
import { FirebasesdkModule } from 'src/firebasesdk/firebasesdk.module';

@Module({
  imports: [FirebasesdkModule],
  controllers: [MaintenanceFeesController],
  providers: [MaintenanceFeesService],
})
export class MaintenanceFeesModule {}
