import { Type } from 'class-transformer';
import { IsArray, IsNotEmpty, IsString, IsOptional, ValidateNested } from 'class-validator';

export class AttachmentDto {
  @IsString()
  @IsNotEmpty()
  fileName: string;

  @IsString()
  @IsNotEmpty()
  filePath: string;
}


export class CreatePublicationDto {
  @IsNotEmpty()
  @IsString()
  title: string;

  @IsNotEmpty()
  @IsString()
  content: string;

  @IsNotEmpty()
  @IsString()
  author: string;

  @IsNotEmpty()
  @IsString()
  clientId: string;

  @IsNotEmpty()
  @IsString()
  tags: string;

  @IsNotEmpty()
  @IsString()
  condominiumName: string;

  @IsNotEmpty()
  @IsString()
  condominiumId: string;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => AttachmentDto)
  attachments?: AttachmentDto[];


  @IsNotEmpty()
  sendTo: string | string[];
}