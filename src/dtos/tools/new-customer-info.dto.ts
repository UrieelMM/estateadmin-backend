import { IsEmail, IsEnum, IsNotEmpty, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class CondominiumInfoDto {
  @IsNotEmpty({ message: 'El nombre del condominio es obligatorio' })
  @IsString()
  name: string;

  @IsNotEmpty({ message: 'La dirección del condominio es obligatoria' })
  @IsString()
  address: string;
}

export class NewCustomerInfoDto {
  // Campos obligatorios
  @IsNotEmpty({ message: 'El nombre es obligatorio' })
  @IsString()
  name: string;

  @IsNotEmpty({ message: 'El apellido es obligatorio' })
  @IsString()
  lastName: string;

  @IsNotEmpty({ message: 'El correo electrónico es obligatorio' })
  @IsEmail({}, { message: 'El correo electrónico debe tener un formato válido' })
  email: string;

  @IsNotEmpty({ message: 'El número telefónico es obligatorio' })
  @IsString()
  phoneNumber: string;

  @IsNotEmpty({ message: 'El nombre de la compañía es obligatorio' })
  @IsString()
  companyName: string;

  @IsNotEmpty({ message: 'El domicilio fiscal es obligatorio' })
  @IsString()
  fullFiscalAddress: string;

  @IsNotEmpty({ message: 'El RFC es obligatorio' })
  @IsString()
  RFC: string;

  @IsNotEmpty({ message: 'El país es obligatorio' })
  @IsString()
  country: string;

  @IsNotEmpty({ message: 'El nombre comercial es obligatorio' })
  @IsString()
  businessName: string;

  @IsNotEmpty({ message: 'El régimen fiscal es obligatorio' })
  @IsString()
  taxRegime: string;

  @IsNotEmpty({ message: 'La actividad económica es obligatoria' })
  @IsString()
  businessActivity: string;

  @IsNotEmpty({ message: 'El nombre de la persona responsable es obligatorio' })
  @IsString()
  responsiblePersonName: string;

  @IsNotEmpty({ message: 'El cargo de la persona responsable es obligatorio' })
  @IsString()
  responsiblePersonPosition: string;

  @IsNotEmpty({ message: 'La información del condominio es obligatoria' })
  @IsObject()
  @ValidateNested()
  @Type(() => CondominiumInfoDto)
  condominiumInfo: CondominiumInfoDto;

  // Campos opcionales con valores predeterminados
  @IsOptional()
  @IsString()
  photoURL?: string;

  @IsOptional()
  @IsEnum(['Basic', 'Essential', 'Professional', 'Premium'], {
    message: 'El plan debe ser uno de los siguientes: Basic, Essential, Professional, Premium',
  })
  plan?: 'Basic' | 'Essential' | 'Professional' | 'Premium' = 'Basic';

  @IsOptional()
  @IsString()
  cfdiUse?: string;

  @IsOptional()
  @IsEnum(['monthly', 'quarterly', 'biannual', 'annual'], {
    message: 'La frecuencia de facturación debe ser una de las siguientes: monthly, quarterly, biannual, annual',
  })
  billingFrequency?: 'monthly' | 'quarterly' | 'biannual' | 'annual' = 'monthly';

  @IsOptional()
  @IsString()
  recordId?: string;
}
