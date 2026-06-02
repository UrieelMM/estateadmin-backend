import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';
import { BillingFrequency, CondominiumStatus } from './register-client.dto';

export class RegisterCondominiumDto {
  @IsNotEmpty()
  @IsString()
  name: string;

  @IsNotEmpty()
  @IsString()
  address: string;

  @IsOptional()
  @IsString()
  condominiumManager?: string;

  @IsNotEmpty()
  @IsString()
  clientId: string;

  @IsNotEmpty()
  @IsString()
  plan: string;

  @IsOptional()
  pricing?: number | string;

  @IsOptional()
  pricingWithoutTax?: number | string;

  @IsOptional()
  pricingWithoutIVA?: number | string;

  @IsOptional()
  pricingWithoutIva?: number | string;

  @IsOptional()
  @IsEnum(BillingFrequency, {
    message:
      'La frecuencia de facturación debe ser monthly, quarterly, biannual o annual',
  })
  billingFrequency?: BillingFrequency;

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
  @IsBoolean()
  hasMaintenanceApp?: boolean;

  @IsOptional()
  @IsDateString()
  maintenanceAppContractedAt?: string;

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

  // Cupón de regalo opcional para condonar la primera factura de suscripción
  // del nuevo condominio. El administrador del condominio debe redimirlo
  // manualmente desde su dashboard mediante /users-auth/redeem-initial-setup-coupon.
  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'El cupón debe tener al menos 8 caracteres' })
  coupon?: string;
}
