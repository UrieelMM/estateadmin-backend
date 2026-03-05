// create-unidentified-payment.dto.ts
import { Transform } from 'class-transformer';
import { IsString, IsNotEmpty, IsOptional, IsBoolean } from 'class-validator';
import {
  sanitizeTowerSnapshot,
  TOWER_SNAPSHOT_MAX_LENGTH,
} from 'src/utils/tower-snapshot';
import { MaxLength } from 'class-validator';

export class CreateUnidentifiedPaymentDto {
  @IsString()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  numberCondominium: string;

  @IsString()
  @IsOptional()
  comments?: string;

  @IsString()
  clientId: string;

  @IsOptional()
  @IsString()
  attachmentPayment: string;

  @IsString()
  @IsOptional()
  paymentId: string;

  @IsString()
  @IsOptional()
  appliedToCondomino: string;

  @IsString()
  condominiumId: string;

  @IsNotEmpty()
  @IsOptional()
  paymentGroupId: string;

  month: string;

  @IsString()
  @IsNotEmpty()
  amountPaid: string; // se recibirá en string y se convertirá en el case

  @IsString()
  @IsNotEmpty()
  amountPending: string;

  @IsString()
  @IsNotEmpty()
  paymentType: string;

  @IsString()
  @IsNotEmpty()
  paymentDate: string; // ISO string

  @IsOptional()
  @IsString()
  paymentReference?: string;

  @IsOptional()
  @Transform(({ value }) => sanitizeTowerSnapshot(value))
  @IsString()
  @MaxLength(TOWER_SNAPSHOT_MAX_LENGTH)
  towerSnapshot?: string;

  @IsString()
  @IsNotEmpty()
  financialAccountId: string;

  // Flag para indicar si ya se aplicó a un usuario (por defecto false)
  @IsOptional()
  @IsBoolean()
  appliedToUser?: boolean;

  // Este DTO siempre representará un pago NO identificado
  readonly isUnidentifiedPayment: boolean = true;
}
