import { Transform, Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const trimString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : String(value ?? '').trim();

const optionalTrimmed = (value: unknown): string | undefined => {
  const normalized = trimString(value);
  return normalized ? normalized : undefined;
};

/** Conserva '' (borrar el campo) y descarta null/undefined (no enviado). */
const trimIfPresent = (value: unknown): string | undefined =>
  value === undefined || value === null ? undefined : trimString(value);

export class ExpenseEditTenantQueryDto {
  @Transform(({ value }) => trimString(value))
  @IsNotEmpty()
  @IsString()
  clientId: string;

  @Transform(({ value }) => trimString(value))
  @IsNotEmpty()
  @IsString()
  condominiumId: string;

  @Transform(({ value }) => trimString(value))
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  expenseId: string;
}

export class ExpenseEditCommitDto extends ExpenseEditTenantQueryDto {
  /** Monto en pesos que el administrador vio antes de editar. */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0.01)
  @Max(10000000)
  expectedAmount: number;

  /** Nuevo monto en pesos. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0.01)
  @Max(10000000)
  amount?: number;

  @Transform(({ value }) => trimIfPresent(value))
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @Transform(({ value }) => optionalTrimmed(value))
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  invoiceUrl?: string;

  @Transform(({ value }) => trimString(value))
  @IsNotEmpty()
  @IsString()
  @MaxLength(300)
  reason: string;

  @Transform(({ value }) => optionalTrimmed(value))
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
