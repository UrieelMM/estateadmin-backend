import { IsEmail, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

class CondominiumInfo {
  @IsNotEmpty()
  @IsString()
  name: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(300)
  address: string;
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
  password: string; // Asegúrate de incluir esto

  @IsNotEmpty()
  @IsString()
  phoneNumber: string;

  @IsNotEmpty()
  @IsString()
  currentPlan: string;

  @IsNotEmpty()
  @IsString()
  companyName: string;

  @IsNotEmpty()
  @IsString()
  address: string;

  @IsNotEmpty()
  @IsString()
  RFC: string;

  @IsNotEmpty()
  @IsString()
  country: string;

  @IsNotEmpty()
  @IsString()
  businessName: string;

  @IsNotEmpty()
  @IsString()
  taxResidence?: string;

  @IsNotEmpty()
  @IsString()
  taxRegime?: string;

  @IsNotEmpty()
  @IsString()
  condominiumName: string;
}