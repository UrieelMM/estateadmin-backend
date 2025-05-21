import { Module } from '@nestjs/common';
import { MpcService } from './mpc.service';

@Module({
  imports: [],
  providers: [MpcService],
  exports: [MpcService],
})
export class MpcModule {}
