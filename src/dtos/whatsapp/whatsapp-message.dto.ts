import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class WhatsappMessageDto {
  @IsString()
  @IsNotEmpty()
  phoneNumber: string;

  @IsString()
  @IsNotEmpty()
  message: string;

  @IsString()
  @IsOptional()
  messageId?: string;

  @IsString()
  @IsOptional()
  timestamp?: string;
}
