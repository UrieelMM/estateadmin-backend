import { IsString, IsNotEmpty, MinLength } from 'class-validator';

export class ConfirmResetPasswordDto {
  @IsString()
  @IsNotEmpty()
  oobCode: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  newPassword: string;
} 