import { Module } from '@nestjs/common';
import { CondominiumUsersController } from './condominium-users.controller';
import { CondominiumUsersService } from './condominium-users.service';
import { ThrottlerModule } from '@nestjs/throttler';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        ttl: 60,
        limit: 10,
      },
    ]),
  ],
  controllers: [CondominiumUsersController],
  providers: [CondominiumUsersService],
  exports: [CondominiumUsersService],
})
export class CondominiumUsersModule {}
