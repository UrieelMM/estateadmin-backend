import { Module } from '@nestjs/common';
import { UsersAuthService } from './users-auth.service';
import { UsersAuthController } from './users-auth.controller';
import { FirebasesdkModule } from '../firebasesdk/firebasesdk.module';

@Module({
  imports: [FirebasesdkModule],
  providers: [UsersAuthService],
  controllers: [UsersAuthController],
})
export class UsersAuthModule {}
