import { Module } from '@nestjs/common';
import { MaintenanceFeesService } from './maintenance-fees.service';
import { MaintenanceFeesController } from './maintenance-fees.controller';
import { FirebasesdkModule } from 'src/firebasesdk/firebasesdk.module';
import { PaymentReversalsController } from './payment-reversals.controller';
import { PaymentReversalsService } from './payment-reversals.service';
import { FinancialClosuresController } from './financial-closures.controller';
import { FinancialClosuresService } from './financial-closures.service';

@Module({
  imports: [FirebasesdkModule],
  controllers: [MaintenanceFeesController, PaymentReversalsController, FinancialClosuresController],
  providers: [MaintenanceFeesService, PaymentReversalsService, FinancialClosuresService],
})
export class MaintenanceFeesModule {}
