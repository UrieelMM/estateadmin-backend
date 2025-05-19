import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class FormUrlDto {
  @IsNotEmpty({ message: 'El ID del formulario es obligatorio' })
  @IsString()
  formId: string;

  @IsOptional()
  @IsString()
  clientName?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class FormUrlResponseDto {
  success: boolean;
  formId: string;
  createdAt: string;
  message: string;
  expirationDate?: string;
}
