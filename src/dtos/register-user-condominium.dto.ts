// src/dtos/user-condominium.dto.ts
import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class UserCondominiumDto {
  @IsString()
  clientId: string;
  
  @IsNotEmpty()
  @IsString()
  name: string;

  @IsNotEmpty()
  @IsString()
  lastName: string;

  @IsEmail()
  email: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  RFC?: string;

  @IsOptional()
  @IsString()
  CP?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  state?: string;


  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsString()
  number?: string;

  @IsOptional()
  @IsString()
  businessName?: string;

  @IsOptional()
  @IsString()
  taxResidence?: string;

  @IsOptional()
  @IsString()
  taxtRegime?: string;

  @IsOptional()
  @IsString()
  photoURL?: string;

  @IsOptional()
  @IsString()
  departament?: string;

  @IsOptional()
  @IsString()
  tower?: string;

  @IsNotEmpty()
  @IsString()
  role: string = 'condominium';
}
