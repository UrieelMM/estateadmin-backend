import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import { CondominiumStatus } from './register-client.dto';

export class RegisterCondominiumDto {
  @IsNotEmpty()
  @IsString()
  name: string;

  @IsNotEmpty()
  @IsString()
  address: string;

  @IsNotEmpty()
  @IsString()
  clientId: string;

  @IsNotEmpty()
  @IsString()
  plan: string;

  @IsNotEmpty()
  @IsNumber()
  condominiumLimit: number;

  @IsNotEmpty()
  @IsEnum(CondominiumStatus, {
    message: 'El estado debe ser pending, active, inactive o blocked',
  })
  status: CondominiumStatus = CondominiumStatus.Pending;

  @IsOptional()
  @IsArray()
  proFunctions: string[];

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/, {
    message: 'La moneda debe ser un código de 3 letras mayúsculas (ej. MXN, USD)',
  })
  currency?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z]{2}(-[A-Z]{2})?$/, {
    message: 'El idioma debe tener formato válido (ej. es-MX, en-US)',
  })
  language?: string;
}
