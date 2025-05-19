import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { CondominiumLimitDto, CondominiumLimitResponseDto } from './condominium-limit.dto';

export class SearchPlacesDto {
  latitude: number;
  longitude: number;
  keyword: string;
  radius: number;
}

export class ContactFormDto {
  @IsNotEmpty({ message: 'El nombre es obligatorio' })
  @IsString()
  name: string;

  @IsNotEmpty({ message: 'El email es obligatorio' })
  @IsEmail({}, { message: 'El email debe tener un formato válido' })
  email: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  message?: string;
}

export { CondominiumLimitDto, CondominiumLimitResponseDto };
