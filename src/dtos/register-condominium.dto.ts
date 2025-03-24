import { IsString, IsNotEmpty } from 'class-validator';

export class RegisterCondominiumDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  address: string;

  @IsString()
  @IsNotEmpty()
  clientId: string;
} 