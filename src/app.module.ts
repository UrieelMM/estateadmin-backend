import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { FirebasesdkModule } from './firebasesdk/firebasesdk.module';
import { UsersAuthModule } from './users-auth/users-auth.module';
import { PublicationsModule } from './publications/publications.module';
import { ParcelModule } from './parcel/parcel.module';
import { MaintenanceFeesModule } from './maintenance-fees/maintenance-fees.module';

@Module({
  imports: [FirebasesdkModule, UsersAuthModule, PublicationsModule, ParcelModule, MaintenanceFeesModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
