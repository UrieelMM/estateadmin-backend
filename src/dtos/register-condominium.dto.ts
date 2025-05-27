import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  Max,
  ValidateIf,
  Matches,
} from 'class-validator';
import { PlanType, CondominiumStatus } from './register-client.dto';

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
  @IsEnum(PlanType, {
    message: 'El plan debe ser Basic, Essential, Professional o Premium',
  })
  plan: PlanType = PlanType.Basic;

  @IsNotEmpty()
  @IsNumber()
  @ValidateIf(o => o.plan === PlanType.Basic)
  @Min(1, { message: 'El plan Basic permite entre 1 y 50 condominios' })
  @Max(50, { message: 'El plan Basic permite entre 1 y 50 condominios' })
  @ValidateIf(o => o.plan === PlanType.Essential)
  @Min(51, { message: 'El plan Essential permite entre 51 y 100 condominios' })
  @Max(100, { message: 'El plan Essential permite entre 51 y 100 condominios' })
  @ValidateIf(o => o.plan === PlanType.Professional)
  @Min(101, { message: 'El plan Professional permite entre 101 y 250 condominios' })
  @Max(250, { message: 'El plan Professional permite entre 101 y 250 condominios' })
  @ValidateIf(o => o.plan === PlanType.Premium)
  @Min(251, { message: 'El plan Premium permite entre 251 y 500 condominios' })
  @Max(500, { message: 'El plan Premium permite entre 251 y 500 condominios' })
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
