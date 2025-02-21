import { Type } from 'class-transformer';
import { IsNotEmpty, IsString, IsOptional, ValidateNested } from 'class-validator';

export class AttachmentParcelDto {
  @IsString()
  @IsNotEmpty()
  fileName: string;

  @IsString()
  @IsNotEmpty()
  filePath: string;
}


export class ParcelDto {

  @IsNotEmpty()
  @IsString()
  email: string;

  @IsNotEmpty()
  @IsString()
  receptor: string;

  @IsNotEmpty()
  @IsString()
  recipientName: string;

  @IsNotEmpty()
  @IsString()
  dateReception: string;

  @IsNotEmpty()
  @IsString()
  hourReception: string;
    
  @IsOptional()
  @IsString()
  comments: string;
    
  @IsNotEmpty()
  @IsString()
  clientId: string;

  @IsNotEmpty()
  @IsString()
  condominiumId: string;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => AttachmentParcelDto)
  attachments?: AttachmentParcelDto[];
}