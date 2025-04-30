import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class UpdateParcelDto {
  @IsNotEmpty()
  @IsString()
  parcelId: string;

  @IsNotEmpty()
  @IsString()
  clientId: string;

  @IsNotEmpty()
  @IsString()
  condominiumId: string;

  @IsNotEmpty()
  @IsString()
  status: string;

  @IsNotEmpty()
  @IsString()
  deliveryPerson: string;

  @IsNotEmpty()
  @IsString()
  deliveredTo: string;

  @IsOptional()
  @IsString()
  deliveryNotes?: string;

  @IsNotEmpty()
  @IsString()
  deliveryDate: string;

  @IsNotEmpty()
  @IsString()
  deliveryHour: string;
} 