// src/dtos/edit-unidentified-payment.dto.ts

import { IsNotEmpty, IsString } from 'class-validator';

export class EditUnidentifiedPaymentDto {
  @IsNotEmpty()
  @IsString()
  paymentId: string;

  @IsNotEmpty()
  @IsString()
  clientId: string;

  @IsNotEmpty()
  @IsString()
  condominiumId: string;

  // Si la fecha la manda el cliente, se puede recibir como string:
  // Pero, como lo quieres forzar a un timestamp, veremos si
  // prefieres generarla en el servidor directamente.
}
