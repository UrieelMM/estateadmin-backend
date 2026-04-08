import { Module } from '@nestjs/common';
import { MaintenanceFeesService } from './maintenance-fees.service';
import { MaintenanceFeesController } from './maintenance-fees.controller';
import { FirebasesdkModule } from 'src/firebasesdk/firebasesdk.module';
import { PaymentReversalsController } from './payment-reversals.controller';
import { PaymentReversalsService } from './payment-reversals.service';

@Module({
  imports: [FirebasesdkModule],
  controllers: [MaintenanceFeesController, PaymentReversalsController],
  providers: [MaintenanceFeesService, PaymentReversalsService],
})
export class MaintenanceFeesModule {}
