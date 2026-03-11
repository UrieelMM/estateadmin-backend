import {
  IsArray,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

class CondominiumInfo {
  @IsNotEmpty()
  @IsString()
  name: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(300)
  address: string;
}

export enum BillingFrequency {
  Monthly = 'monthly',
  Quarterly = 'quarterly',
  Biannual = 'biannual',
  Annual = 'annual',
}

export enum CondominiumStatus {
  Pending = 'pending',
  Active = 'active',
  Inactive = 'inactive',
  Blocked = 'blocked',
}

export class RegisterClientDto {
  @IsNotEmpty()
  condominiumInfo: CondominiumInfo;

  @IsNotEmpty()
  @IsString()
  name: string;

  @IsNotEmpty()
  @IsString()
  lastName: string;

  @IsOptional()
  @IsString()
  photoURL: string;

  @IsEmail()
  email: string;

  @IsNotEmpty()
  password: string;

  @IsNotEmpty()
  @IsString()
  phoneNumber: string;

  @IsOptional()
  @IsString()
  plan: string;

  @IsOptional()
  pricing?: number | string;

  @IsOptional()
  @IsArray()
  proFunctions: string[];

  // Razón social (nombre legal completo)
  @IsNotEmpty()
  @IsString()
  companyName: string;

  // Domicilio fiscal completo
  @IsNotEmpty()
  @IsString()
  @MaxLength(500)
  fullFiscalAddress: string;

  // RFC
  @IsNotEmpty()
  @IsString()
  RFC: string;

  @IsNotEmpty()
  @IsString()
  country: string;

  @IsNotEmpty()
  @IsString()
  businessName: string;

  // Régimen fiscal
  @IsNotEmpty()
  @IsString()
  taxRegime: string;

  // Giro o actividad económica
  @IsNotEmpty()
  @IsString()
  businessActivity: string;

  // Nombre de la persona responsable
  @IsNotEmpty()
  @IsString()
  responsiblePersonName: string;

  // Cargo de la persona responsable
  @IsNotEmpty()
  @IsString()
  responsiblePersonPosition: string;

  // Correo electrónico principal (ya tenemos email)

  // Uso de CFDI (opcional)
  @IsOptional()
  @IsString()
  cfdiUse: string;

  // Fecha de inicio de servicio (se genera automáticamente)
  @IsOptional()
  serviceStartDate: Date = new Date();

  // Periodicidad de facturación
  @IsOptional()
  @IsEnum(BillingFrequency)
  billingFrequency: BillingFrequency = BillingFrequency.Monthly;

  // Límite de condominios
  @IsNotEmpty()
  @IsNumber()
  @Min(1, { message: 'El límite de condominios debe ser mayor o igual a 1' })
  condominiumLimit: number;

  // Aceptación de términos y condiciones
  @IsOptional()
  termsAccepted: boolean = true;

  // Campo de dirección original que mantenemos para compatibilidad
  @IsOptional()
  @IsString()
  address: string;

  // Moneda predeterminada para el cliente
  @IsOptional()
  @IsString()
  currency: string = 'MXN';

  // Idioma predeterminado para el cliente
  @IsOptional()
  @IsString()
  language: string = 'es';

  // Indica si el cliente tiene la app de mantenimiento
  @IsOptional()
  hasMaintenanceApp: boolean;
}
