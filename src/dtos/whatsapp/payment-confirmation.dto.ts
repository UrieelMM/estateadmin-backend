import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class PaymentConfirmationDto {
  @IsString()
  @IsNotEmpty()
  phoneNumber: string;

  @IsString()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  departmentNumber: string;

  // Opcional: URL o identificador del comprobante (imagen o archivo)
  @IsString()
  @IsOptional()
  paymentProofUrl?: string;

  @IsString()
  @IsOptional()
  selectedChargeIds?: string[];
}
