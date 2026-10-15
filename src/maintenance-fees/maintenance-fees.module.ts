import { Module } from '@nestjs/common';
import { MaintenanceFeesService } from './maintenance-fees.service';
import { MaintenanceFeesController } from './maintenance-fees.controller';
import { FirebasesdkModule } from 'src/firebasesdk/firebasesdk.module';
import { PaymentReversalsController } from './payment-reversals.controller';
import { PaymentReversalsService } from './payment-reversals.service';
import { FinancialClosuresController } from './financial-closures.controller';
import { FinancialClosuresService } from './financial-closures.service';
import { ExpenseReversalsController } from './expense-reversals.controller';
import { ExpenseReversalsService } from './expense-reversals.service';
import { ExpenseEditsController } from './expense-edits.controller';
import { ExpenseEditsService } from './expense-edits.service';
import { OpeningCreditsController } from './opening-credits.controller';
import { OpeningCreditsService } from './opening-credits.service';

@Module({
  imports: [FirebasesdkModule],
  controllers: [
    MaintenanceFeesController,
    PaymentReversalsController,
    FinancialClosuresController,
    ExpenseReversalsController,
    ExpenseEditsController,
    OpeningCreditsController,
  ],
  providers: [
    MaintenanceFeesService,
    PaymentReversalsService,
    FinancialClosuresService,
    ExpenseReversalsService,
    ExpenseEditsService,
    OpeningCreditsService,
  ],
})
export class MaintenanceFeesModule {}
