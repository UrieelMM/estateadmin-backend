import {
  IsArray,
  IsNotEmpty,
  IsString,
  IsBoolean,
  IsOptional,
  IsEmail,
  IsEnum,
} from 'class-validator';

export enum AdministratorRole {
  ADMIN = 'admin',
  ADMIN_ASSISTANT = 'admin-assistant',
}

export class EditUserDto {
  @IsString()
  @IsNotEmpty()
  clientId: string;

  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  lastName: string;

  @IsArray()
  @IsNotEmpty()
  condominiumUids: string[];

  @IsEnum(AdministratorRole)
  @IsNotEmpty()
  role: AdministratorRole;

  @IsBoolean()
  @IsNotEmpty()
  active: boolean;

  @IsOptional()
  @IsString()
  photoURL?: string;
}
