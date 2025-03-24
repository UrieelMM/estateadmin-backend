import { IsArray, IsNotEmpty, IsString, IsBoolean, IsOptional } from 'class-validator';

export class EditUserDto {
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
  @IsNotEmpty()
  role: string;

  @IsBoolean()
  @IsOptional()
  active: boolean;
} 