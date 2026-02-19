import { IsEnum, IsNotEmpty, IsString } from 'class-validator';

export enum AttendanceRegisterType {
  CHECK_IN = 'check-in',
  CHECK_OUT = 'check-out',
}

export class AttendanceQrValidateQueryDto {
  @IsString()
  @IsNotEmpty()
  clientId: string;

  @IsString()
  @IsNotEmpty()
  condominiumId: string;
}

export class AttendanceQrRegisterDto {
  @IsString()
  @IsNotEmpty()
  clientId: string;

  @IsString()
  @IsNotEmpty()
  condominiumId: string;

  @IsString()
  @IsNotEmpty()
  employeeNumber: string;

  @IsString()
  @IsNotEmpty()
  pin: string;

  @IsEnum(AttendanceRegisterType)
  type: AttendanceRegisterType;
}
