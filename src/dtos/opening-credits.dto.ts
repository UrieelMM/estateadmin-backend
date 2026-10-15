import { Transform, Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
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

export class OpeningCreditTenantQueryDto {
  @Transform(({ value }) => trimString(value))
  @IsNotEmpty()
  @IsString()
  clientId: string;

  @Transform(({ value }) => trimString(value))
  @IsNotEmpty()
  @IsString()
  condominiumId: string;
}

export class OpeningCreditCreateDto extends OpeningCreditTenantQueryDto {
  @Transform(({ value }) => trimString(value))
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  userId: string;

  /** Monto en pesos. */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0.01)
  @Max(10000000)
  amount: number;

  @Transform(({ value }) => optionalTrimmed(value))
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  cutoffDate?: string;

  @Transform(({ value }) => optionalTrimmed(value))
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class OpeningCreditCancelDto extends OpeningCreditTenantQueryDto {
  @Transform(({ value }) => trimString(value))
  @IsNotEmpty()
  @IsString()
  @MaxLength(300)
  reason: string;
}
