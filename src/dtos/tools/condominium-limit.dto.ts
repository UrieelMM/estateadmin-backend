import { IsNotEmpty, IsString } from 'class-validator';

export class CondominiumLimitDto {
  @IsNotEmpty({ message: 'El clientId es obligatorio' })
  @IsString()
  clientId: string;

  @IsNotEmpty({ message: 'El condominiumId es obligatorio' })
  @IsString()
  condominiumId: string;
}

export class CondominiumLimitResponseDto {
  condominiumLimit: number;
}
