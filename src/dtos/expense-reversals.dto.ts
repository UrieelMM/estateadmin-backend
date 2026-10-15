import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
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

const clampInt = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

export class ExpenseReversalPreviewDto {
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

export class ExpenseReversalCommitDto {
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

  @Transform(({ value }) => trimString(value))
  @IsNotEmpty()
  @IsString()
  @MaxLength(80)
  operationId: string;

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

export class ExpenseReversalHistoryQueryDto {
  @Transform(({ value }) => trimString(value))
  @IsNotEmpty()
  @IsString()
  clientId: string;

  @Transform(({ value }) => trimString(value))
  @IsNotEmpty()
  @IsString()
  condominiumId: string;

  @Type(() => Number)
  @Transform(({ value }) => clampInt(value, 1, 1, 100000))
  @IsInt()
  @Min(1)
  page = 1;

  @Type(() => Number)
  @Transform(({ value }) => clampInt(value, 10, 1, 100))
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 10;

  @Transform(({ value }) => optionalTrimmed(value))
  @IsOptional()
  @IsString()
  from?: string;

  @Transform(({ value }) => optionalTrimmed(value))
  @IsOptional()
  @IsString()
  to?: string;

  @Transform(({ value }) => optionalTrimmed(value))
  @IsOptional()
  @IsString()
  @MaxLength(60)
  folio?: string;
}
