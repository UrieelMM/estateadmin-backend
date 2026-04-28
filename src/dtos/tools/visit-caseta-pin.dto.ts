import {
  IsNotEmpty,
  IsString,
  Matches,
} from 'class-validator';

export class SetCasetaPinDto {
  @IsString()
  @IsNotEmpty()
  clientId: string;

  @IsString()
  @IsNotEmpty()
  condominiumId: string;

  /** PIN de exactamente 6 dígitos numéricos. */
  @IsString()
  @Matches(/^\d{6}$/, { message: 'El PIN debe ser exactamente 6 dígitos.' })
  pin: string;
}

export class CasetaPinStatusQueryDto {
  @IsString()
  @IsNotEmpty()
  clientId: string;

  @IsString()
  @IsNotEmpty()
  condominiumId: string;
}

export class ClearCasetaPinDto {
  @IsString()
  @IsNotEmpty()
  clientId: string;

  @IsString()
  @IsNotEmpty()
  condominiumId: string;
}
