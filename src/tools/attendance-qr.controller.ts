import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { Request } from 'express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ToolsService } from './tools.service';
import {
  AttendanceQrRegisterDto,
  AttendanceQrValidateQueryDto,
} from 'src/dtos/tools';

@Controller('attendance-qr')
@UseGuards(ThrottlerGuard)
export class AttendanceQrController {
  constructor(private readonly toolsService: ToolsService) {}

  @Get(':qrId')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async validateQr(
    @Param('qrId') qrId: string,
    @Query() query: AttendanceQrValidateQueryDto,
  ) {
    return this.toolsService.validatePublicAttendanceQr(
      qrId,
      query.clientId,
      query.condominiumId,
    );
  }

  @Post(':qrId/register')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async registerAttendance(
    @Param('qrId') qrId: string,
    @Body() body: AttendanceQrRegisterDto,
    @Req() req: Request,
  ) {
    return this.toolsService.registerAttendanceFromPublicQr(qrId, body, req);
  }
}
