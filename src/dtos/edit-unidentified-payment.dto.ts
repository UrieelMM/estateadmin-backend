// src/dtos/edit-unidentified-payment.dto.ts

import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  sanitizeTowerSnapshot,
  TOWER_SNAPSHOT_MAX_LENGTH,
} from 'src/utils/tower-snapshot';

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

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  appliedToCondomino?: string;

  @IsOptional()
  @Transform(({ value }) => sanitizeTowerSnapshot(value))
  @IsString()
  @MaxLength(TOWER_SNAPSHOT_MAX_LENGTH)
  appliedTowerSnapshot?: string;

  // Si la fecha la manda el cliente, se puede recibir como string:
  // Pero, como lo quieres forzar a un timestamp, veremos si
  // prefieres generarla en el servidor directamente.
}
