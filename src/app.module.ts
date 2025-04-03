import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { FirebasesdkModule } from './firebasesdk/firebasesdk.module';
import { UsersAuthModule } from './users-auth/users-auth.module';
import { PublicationsModule } from './publications/publications.module';
import { ParcelModule } from './parcel/parcel.module';
import { MaintenanceFeesModule } from './maintenance-fees/maintenance-fees.module';
import { ThrottlerModule } from '@nestjs/throttler';
import { ToolsModule } from './tools/tools.module';
import { StripeModule } from './stripe/stripe.module';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        ttl: 60000, // tiempo en segundos
        limit: 15, // número máximo de peticiones en el período ttl
      },
    ]),
    FirebasesdkModule,
    UsersAuthModule,
    PublicationsModule,
    ParcelModule,
    MaintenanceFeesModule,
    ToolsModule,
    StripeModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
