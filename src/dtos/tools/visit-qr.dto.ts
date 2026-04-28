import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export enum VisitRegisterType {
  CHECK_IN = 'check-in',
  CHECK_OUT = 'check-out',
}

export class ValidateVisitQrQueryDto {
  @IsString()
  @IsNotEmpty()
  token: string;

  @IsOptional()
  @IsString()
  clientId?: string;

  @IsOptional()
  @IsString()
  condominiumId?: string;
}

export class RegisterVisitEntryDto {
  @IsString()
  @IsNotEmpty()
  token: string;

  @IsEnum(VisitRegisterType)
  type: VisitRegisterType;

  @IsOptional()
  @IsString()
  clientId?: string;

  @IsOptional()
  @IsString()
  condominiumId?: string;

  /** PIN de 6 dígitos de la caseta. Requerido si el condominio tiene PIN configurado. */
  @IsOptional()
  @IsString()
  pin?: string;
}
