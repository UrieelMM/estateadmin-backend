import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export const UPSERT_MODES = ['upsert', 'update_only', 'create_only'] as const;
export type UpsertMode = (typeof UPSERT_MODES)[number];

export const UPSERT_MATCH_BY = ['auto', 'email', 'number_tower'] as const;
export type UpsertMatchBy = (typeof UPSERT_MATCH_BY)[number];

export interface UpsertCondominiumUsersOptions {
  skipEmptyUpdates: boolean;
  matchBy: UpsertMatchBy;
  allowRoleUpdate: boolean;
  allowEmailUpdate: boolean;
  allowNumberUpdate: boolean;
}

export interface UpsertActor {
  uid: string;
  email: string;
  role: string;
  clientId: string;
}

export class UpsertCondominiumUsersDryRunDto {
  @IsNotEmpty()
  @IsString()
  clientId: string;

  @IsNotEmpty()
  @IsString()
  condominiumId: string;

  @IsOptional()
  @IsIn(UPSERT_MODES)
  mode?: UpsertMode;

  @IsOptional()
  @IsString()
  options?: string;
}

export class UpsertCondominiumUsersCommitDto {
  @IsNotEmpty()
  @IsString()
  clientId: string;

  @IsNotEmpty()
  @IsString()
  condominiumId: string;

  @IsNotEmpty()
  @IsString()
  operationId: string;
}
