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
  Max,
  ValidateIf,
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

export enum PlanType {
  Basic = 'Basic',
  Essential = 'Essential',
  Professional = 'Professional',
  Premium = 'Premium',
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
  @IsEnum(PlanType, {
    message: 'El plan debe ser Basic, Essential, Professional o Premium',
  })
  plan: PlanType = PlanType.Basic;

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

  // Aceptación de términos y condiciones
  @IsOptional()
  termsAccepted: boolean = true;

  // Campo de dirección original que mantenemos para compatibilidad
  @IsOptional()
  @IsString()
  address: string;
}
