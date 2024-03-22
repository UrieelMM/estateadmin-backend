import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { FirebasesdkModule } from './firebasesdk/firebasesdk.module';
import { UsersAuthModule } from './users-auth/users-auth.module';
import { PublicationsModule } from './publications/publications.module';

@Module({
  imports: [FirebasesdkModule, UsersAuthModule, PublicationsModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
