import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class RegisterSuperAdminDto {
  @IsNotEmpty()
  @IsString()
  name: string;

  @IsNotEmpty()
  @IsString()
  lastName: string;

  @IsNotEmpty()
  @IsEmail()
  email: string;

  @IsNotEmpty()
  @IsString()
  password: string;

  @IsOptional()
  @IsString()
  photoURL?: string = '';
}
