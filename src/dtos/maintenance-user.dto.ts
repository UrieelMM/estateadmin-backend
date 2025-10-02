import { IsString, IsEmail, IsArray, IsOptional, IsNotEmpty } from 'class-validator';

export class CreateMaintenanceUserDto {
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
  phone: string;

  @IsString()
  @IsNotEmpty()
  company: string;

  @IsString()
  @IsNotEmpty()
  responsibleName: string;

  @IsString()
  @IsNotEmpty()
  responsiblePhone: string;

  @IsString()
  @IsNotEmpty()
  emergencyNumber: string;

  @IsArray()
  @IsNotEmpty()
  assignedCondominiums: string[];

  @IsOptional()
  photo?: any; // File will be handled separately in the controller
}

export class UpdateMaintenanceUserDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsNotEmpty()
  clientId: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  phone: string;

  @IsString()
  @IsNotEmpty()
  company: string;

  @IsString()
  @IsNotEmpty()
  responsibleName: string;

  @IsString()
  @IsNotEmpty()
  responsiblePhone: string;

  @IsString()
  @IsNotEmpty()
  emergencyNumber: string;

  @IsArray()
  @IsNotEmpty()
  assignedCondominiums: string[];

  @IsOptional()
  photo?: any; // File will be handled separately in the controller
}
