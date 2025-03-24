import { IsArray, IsEmail, IsNotEmpty, IsString, IsBoolean, IsOptional } from 'class-validator';

export class RegisterUserDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  password: string;

  @IsString()
  @IsNotEmpty()
  clientId: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  lastName: string;

  @IsArray()
  @IsNotEmpty()
  condominiumUids: string[];

  @IsString()
  @IsOptional()
  photoURL?: string;

  @IsString()
  @IsNotEmpty()
  role: string;

  @IsBoolean()
  @IsOptional()
  active: boolean = true;
}