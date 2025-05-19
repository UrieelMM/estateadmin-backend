import { IsNotEmpty, IsString } from 'class-validator';

export class FormExpirationDto {
  @IsNotEmpty({ message: 'El ID del formulario es obligatorio' })
  @IsString()
  formId: string;
}

export class FormExpirationResponseDto {
  expired: boolean;
  formId: string;
  message: string;
  expirationDate?: string;
  daysRemaining?: number;
  usedAt?: string;
}
